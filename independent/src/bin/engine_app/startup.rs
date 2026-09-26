//! Binary-private password/Transport startup and cancellation cleanup.
//! Protocol providers own wire behavior; the generic operation owner arbitrates cancellation.
use super::engine_control::{ControlInput, PendingControlActions};
use super::engine_events::EngineLifecycle;
use super::engine_failure::{
    EngineFailure, EngineResult, attach_cleanup_status, authentication_failure,
    cancelled_connection_attempt_failure, data_plane_setup_error_code, event_output_failure,
    failure, failure_preserving_cleanup,
};
use super::engine_operation::{
    ConnectionOperationCancellationCause, ConnectionOperationOutcome,
    drive_blocking_connection_operation,
};
use ec_compat::engine::auth_lifecycle::BlockingOperation;
use ec_compat::engine::auth_transaction::AUTH_TRANSACTION_TIMEOUT_MS;
use ec_compat::engine::control::ControlAction;
use ec_compat::engine::event::{EngineErrorCode, StopReason};
use ec_compat::engine::provider::ProviderError;
use ec_compat::engine::provider_composition::ProductionProviderSet;
use ec_compat::engine::session::{AuthenticatedGatewaySession, ModernL3Connection};
use ec_compat::{Error, ErrorKind, Result};
use std::io::Write;
use std::time::Duration;

const CONTROL_PREAUTH_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const TRANSPORT_BOOTSTRAP_TIMEOUT: Duration = Duration::from_millis(AUTH_TRANSACTION_TIMEOUT_MS);

pub(super) fn failure_after_gateway_cleanup(
    session: AuthenticatedGatewaySession,
    failure: EngineFailure,
) -> EngineFailure {
    if session.logout().is_err() {
        failure.with_secondary_code(Some(EngineErrorCode::AuthCleanupUnconfirmed))
    } else {
        failure
    }
}

pub(super) async fn authenticate_password_with_lifecycle<W: Write>(
    providers: &ProductionProviderSet,
    gateway_username: zeroize::Zeroizing<String>,
    gateway_password: zeroize::Zeroizing<String>,
    control_receiver: &mut Option<tokio::sync::mpsc::Receiver<ControlInput>>,
    pending_control_actions: &mut PendingControlActions,
    lifecycle: &mut EngineLifecycle<W>,
) -> EngineResult<Option<AuthenticatedGatewaySession>> {
    let authentication_provider = providers.authentication_provider();
    let mut authentication = BlockingOperation::spawn(move |cancellation| {
        authentication_provider.authenticate_password_cancellable(
            &gateway_username,
            &gateway_password,
            &cancellation,
        )
    });
    let authentication_deadline =
        tokio::time::Instant::now() + Duration::from_millis(AUTH_TRANSACTION_TIMEOUT_MS);
    let outcome = drive_blocking_connection_operation(
        &mut authentication,
        authentication_deadline,
        control_receiver,
        pending_control_actions,
        lifecycle,
    )
    .await;
    let (cause, completion) = match outcome {
        ConnectionOperationOutcome::Completed(provider_result) => {
            return provider_result.map(Some).map_err(authentication_failure);
        }
        ConnectionOperationOutcome::WorkerFailed(error) => {
            return Err(attach_cleanup_status(
                failure(
                    EngineErrorCode::AuthIndeterminate,
                    StopReason::StartupFailed,
                    error,
                ),
                true,
            ));
        }
        ConnectionOperationOutcome::Cancelled { cause, completion } => (cause, completion),
    };
    if let Err(error) = lifecycle.begin_stopping() {
        let cleanup_unconfirmed = authentication_completion_cleanup_unconfirmed(completion);
        return Err(attach_cleanup_status(
            event_output_failure(error),
            cleanup_unconfirmed,
        ));
    }
    let cleanup_unconfirmed = authentication_completion_cleanup_unconfirmed(completion);
    match cause {
        ConnectionOperationCancellationCause::UserRequested if cleanup_unconfirmed => {
            Err(cancelled_connection_attempt_failure(
                "authentication cancellation cleanup is unconfirmed",
            ))
        }
        ConnectionOperationCancellationCause::UserRequested => Ok(None),
        ConnectionOperationCancellationCause::DeadlineExpired => {
            let primary = Error::classified(
                ErrorKind::AuthenticationExpired,
                "authentication transaction reached its total deadline",
            );
            let primary = if cleanup_unconfirmed {
                primary.with_cleanup_unconfirmed()
            } else {
                primary
            };
            Err(authentication_failure(ProviderError::Failed(primary)))
        }
        ConnectionOperationCancellationCause::SignalFailed(error) => Err(attach_cleanup_status(
            failure(
                EngineErrorCode::ShutdownSignalFailed,
                StopReason::ShutdownFailed,
                error,
            ),
            cleanup_unconfirmed,
        )),
        ConnectionOperationCancellationCause::ControlOutputFailed(error) => Err(
            attach_cleanup_status(event_output_failure(error), cleanup_unconfirmed),
        ),
    }
}

fn authentication_completion_cleanup_unconfirmed(
    completion: Result<std::result::Result<AuthenticatedGatewaySession, ProviderError>>,
) -> bool {
    match completion {
        Ok(Ok(session)) => session.logout().is_err(),
        Ok(Err(ProviderError::Failed(error))) => error.cleanup_unconfirmed(),
        Ok(Err(_)) => false,
        Err(_) => true,
    }
}

pub(super) async fn prepare_transport_with_lifecycle<W: Write>(
    providers: &ProductionProviderSet,
    session: AuthenticatedGatewaySession,
    control_receiver: &mut Option<tokio::sync::mpsc::Receiver<ControlInput>>,
    pending_control_actions: &mut PendingControlActions,
    lifecycle: &mut EngineLifecycle<W>,
) -> EngineResult<Option<(AuthenticatedGatewaySession, ModernL3Connection)>> {
    let backend = providers.transport_backend();
    let mut transport = BlockingOperation::spawn(move |cancellation| {
        backend.connect_or_logout_cancellable(session, &cancellation)
    });
    let outcome = drive_blocking_connection_operation(
        &mut transport,
        tokio::time::Instant::now() + TRANSPORT_BOOTSTRAP_TIMEOUT,
        control_receiver,
        pending_control_actions,
        lifecycle,
    )
    .await;
    let (cause, completion) = match outcome {
        ConnectionOperationOutcome::Completed(result) => {
            return result.map(Some).map_err(|error| {
                failure_preserving_cleanup(
                    data_plane_setup_error_code(&error),
                    StopReason::StartupFailed,
                    error,
                )
            });
        }
        ConnectionOperationOutcome::WorkerFailed(error) => {
            return Err(attach_cleanup_status(
                failure(
                    EngineErrorCode::DataPlaneSetupFailed,
                    StopReason::StartupFailed,
                    error,
                ),
                true,
            ));
        }
        ConnectionOperationOutcome::Cancelled { cause, completion } => (cause, completion),
    };
    let cleanup_unconfirmed = transport_completion_cleanup_unconfirmed(completion);
    if let Err(error) = lifecycle.begin_stopping() {
        return Err(attach_cleanup_status(
            event_output_failure(error),
            cleanup_unconfirmed,
        ));
    }
    match cause {
        ConnectionOperationCancellationCause::UserRequested if cleanup_unconfirmed => Err(
            cancelled_connection_attempt_failure("transport cancellation cleanup is unconfirmed"),
        ),
        ConnectionOperationCancellationCause::UserRequested => Ok(None),
        ConnectionOperationCancellationCause::DeadlineExpired => Err(attach_cleanup_status(
            failure(
                EngineErrorCode::DataPlaneSetupFailed,
                StopReason::StartupFailed,
                Error::classified(
                    ErrorKind::Transport,
                    "transport bootstrap reached its total deadline",
                ),
            ),
            cleanup_unconfirmed,
        )),
        ConnectionOperationCancellationCause::SignalFailed(error) => Err(attach_cleanup_status(
            failure(
                EngineErrorCode::ShutdownSignalFailed,
                StopReason::ShutdownFailed,
                error,
            ),
            cleanup_unconfirmed,
        )),
        ConnectionOperationCancellationCause::ControlOutputFailed(error) => Err(
            attach_cleanup_status(event_output_failure(error), cleanup_unconfirmed),
        ),
    }
}

fn transport_completion_cleanup_unconfirmed(
    completion: Result<
        std::result::Result<(AuthenticatedGatewaySession, ModernL3Connection), Error>,
    >,
) -> bool {
    match completion {
        Ok(Ok((session, connection))) => {
            drop(connection);
            session.logout().is_err()
        }
        Ok(Err(error)) => error.cleanup_unconfirmed(),
        Err(_) => true,
    }
}

pub(super) async fn emit_initial_control_exchange<W: Write>(
    receiver: &mut Option<tokio::sync::mpsc::Receiver<ControlInput>>,
    lifecycle: &mut EngineLifecycle<W>,
) -> EngineResult<()> {
    let Some(active) = receiver.as_mut() else {
        return Ok(());
    };
    let deadline = tokio::time::Instant::now() + CONTROL_PREAUTH_HANDSHAKE_TIMEOUT;
    loop {
        match tokio::time::timeout_at(deadline, active.recv()).await {
            Ok(Some(ControlInput::V2(exchange))) => {
                lifecycle
                    .emit_control(&exchange)
                    .map_err(event_output_failure)?;
                if matches!(exchange.action, Some(ControlAction::Close { .. })) {
                    *receiver = None;
                }
                return Ok(());
            }
            Ok(Some(ControlInput::V3(request))) => lifecycle
                .reject_auth_control(&request)
                .map_err(event_output_failure)?,
            Ok(None) => {
                *receiver = None;
                return Ok(());
            }
            // Control v2 remains optional for the password-only production
            // provider. A future interactive provider must promote this to a
            // fail-closed requirement before exposing an auth challenge.
            Err(_) => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authentication_failure_completion_preserves_cleanup_uncertainty() {
        let clean = ProviderError::Failed(Error::classified(
            ErrorKind::AuthenticationRejected,
            "synthetic rejection",
        ));
        assert!(!authentication_completion_cleanup_unconfirmed(Ok(Err(
            clean
        ))));
        let uncertain = ProviderError::Failed(
            Error::classified(
                ErrorKind::AuthenticationIndeterminate,
                "synthetic uncertainty",
            )
            .with_cleanup_unconfirmed(),
        );
        assert!(authentication_completion_cleanup_unconfirmed(Ok(Err(
            uncertain
        ))));
        assert!(authentication_completion_cleanup_unconfirmed(Err(
            Error::classified(ErrorKind::Lifecycle, "synthetic worker failure")
        )));
        assert!(!authentication_completion_cleanup_unconfirmed(Ok(Err(
            ProviderError::unsupported(ec_compat::engine::provider::Capability::AuthSms)
        ))));
    }

    #[test]
    fn transport_failure_completion_preserves_cleanup_uncertainty() {
        assert!(!transport_completion_cleanup_unconfirmed(Ok(Err(
            Error::classified(ErrorKind::Transport, "synthetic failure")
        ))));
        assert!(transport_completion_cleanup_unconfirmed(Ok(Err(
            Error::classified(ErrorKind::Transport, "synthetic uncertainty")
                .with_cleanup_unconfirmed()
        ))));
        assert!(transport_completion_cleanup_unconfirmed(Err(
            Error::classified(ErrorKind::Lifecycle, "synthetic worker failure")
        )));
    }

    #[test]
    fn cancelled_attempt_with_unconfirmed_cleanup_is_not_a_clean_user_stop() {
        let completion = Ok(Err(ProviderError::Failed(
            Error::classified(ErrorKind::Lifecycle, "synthetic cancellation")
                .with_cleanup_unconfirmed(),
        )));
        assert!(authentication_completion_cleanup_unconfirmed(completion));
        let failure = cancelled_connection_attempt_failure("synthetic cleanup failure");
        assert_eq!(failure.code, EngineErrorCode::LogoutFailed);
        assert_eq!(failure.stop_reason, StopReason::LogoutFailed);
        assert_eq!(
            failure.secondary_code,
            Some(EngineErrorCode::AuthCleanupUnconfirmed)
        );
    }
}
