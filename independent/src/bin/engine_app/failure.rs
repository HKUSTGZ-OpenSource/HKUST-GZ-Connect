//! Binary-private stable failure mapping. No resource ownership or I/O.
use ec_compat::engine::event::{EngineErrorCode, StopReason};
use ec_compat::engine::provider::ProviderError;
use ec_compat::{Error, ErrorKind};

pub(super) struct EngineFailure {
    pub(super) code: EngineErrorCode,
    pub(super) secondary_code: Option<EngineErrorCode>,
    pub(super) stop_reason: StopReason,
    pub(super) error: Error,
}

impl EngineFailure {
    fn new(code: EngineErrorCode, stop_reason: StopReason, error: Error) -> Self {
        Self {
            code,
            secondary_code: None,
            stop_reason,
            error,
        }
    }

    pub(super) fn with_secondary_code(mut self, secondary_code: Option<EngineErrorCode>) -> Self {
        self.secondary_code = secondary_code;
        self
    }
}

pub(super) type EngineResult<T> = std::result::Result<T, EngineFailure>;

pub(super) fn failure(
    code: EngineErrorCode,
    stop_reason: StopReason,
    error: Error,
) -> EngineFailure {
    EngineFailure::new(code, stop_reason, error)
}

pub(super) fn event_output_failure(error: Error) -> EngineFailure {
    failure(
        EngineErrorCode::EventOutputFailed,
        StopReason::EventOutputFailed,
        error,
    )
}

fn authentication_error_code(error: &ProviderError) -> EngineErrorCode {
    match error {
        ProviderError::Unsupported(capability) if capability.is_authentication() => {
            EngineErrorCode::UnsupportedAuthentication
        }
        ProviderError::Failed(error) if error.kind() == ErrorKind::Configuration => {
            EngineErrorCode::ConfigurationInvalid
        }
        ProviderError::Failed(error) if error.kind() == ErrorKind::Credentials => {
            EngineErrorCode::CredentialsInvalid
        }
        ProviderError::Failed(error) => match error.kind() {
            ErrorKind::AuthenticationRejected => EngineErrorCode::AuthRejected,
            ErrorKind::GatewayPreloginUnavailable => EngineErrorCode::GatewayPreloginUnavailable,
            ErrorKind::AuthenticationIndeterminate
            | ErrorKind::GatewayHttp
            | ErrorKind::GatewayHttpIndeterminate => EngineErrorCode::AuthIndeterminate,
            ErrorKind::AuthenticationProtocolInvalid | ErrorKind::GatewayProtocolInvalid => {
                EngineErrorCode::AuthProtocolInvalid
            }
            ErrorKind::AuthenticationExpired => EngineErrorCode::AuthExpired,
            ErrorKind::AuthenticationLimitExceeded => EngineErrorCode::AuthLimitExceeded,
            ErrorKind::UnsupportedCapability => EngineErrorCode::UnsupportedAuthentication,
            _ => EngineErrorCode::AuthIndeterminate,
        },
        _ => EngineErrorCode::AuthIndeterminate,
    }
}

pub(super) fn gateway_connector_error_code(error: &Error) -> EngineErrorCode {
    match error.kind() {
        ErrorKind::Configuration => EngineErrorCode::ConfigurationInvalid,
        ErrorKind::GatewayHttp => EngineErrorCode::GatewayPreloginUnavailable,
        _ => EngineErrorCode::AuthIndeterminate,
    }
}

pub(super) fn authentication_failure(error: ProviderError) -> EngineFailure {
    let code = authentication_error_code(&error);
    let cleanup_unconfirmed = matches!(
        &error,
        ProviderError::Failed(error) if error.cleanup_unconfirmed()
    );
    failure(code, StopReason::StartupFailed, Error::from(error))
        .with_secondary_code(cleanup_unconfirmed.then_some(EngineErrorCode::AuthCleanupUnconfirmed))
}

pub(super) fn data_plane_setup_error_code(error: &Error) -> EngineErrorCode {
    match error.kind() {
        ErrorKind::Configuration => EngineErrorCode::ConfigurationInvalid,
        ErrorKind::DataPlaneTransient => EngineErrorCode::DataPlaneSetupTransient,
        _ => EngineErrorCode::DataPlaneSetupFailed,
    }
}

pub(super) fn failure_preserving_cleanup(
    code: EngineErrorCode,
    stop_reason: StopReason,
    error: Error,
) -> EngineFailure {
    let cleanup_unconfirmed = error.cleanup_unconfirmed();
    failure(code, stop_reason, error)
        .with_secondary_code(cleanup_unconfirmed.then_some(EngineErrorCode::AuthCleanupUnconfirmed))
}

pub(super) fn attach_cleanup_status(
    failure: EngineFailure,
    cleanup_unconfirmed: bool,
) -> EngineFailure {
    if cleanup_unconfirmed {
        failure.with_secondary_code(Some(EngineErrorCode::AuthCleanupUnconfirmed))
    } else {
        failure
    }
}

pub(super) fn cancelled_connection_attempt_failure(message: &'static str) -> EngineFailure {
    attach_cleanup_status(
        failure(
            EngineErrorCode::LogoutFailed,
            StopReason::LogoutFailed,
            Error::classified(ErrorKind::Lifecycle, message),
        ),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_resolution_failure_is_retryable_only_before_authentication() {
        assert_eq!(
            gateway_connector_error_code(&Error::classified(
                ErrorKind::GatewayHttp,
                "synthetic DNS failure"
            )),
            EngineErrorCode::GatewayPreloginUnavailable
        );
        assert_eq!(
            gateway_connector_error_code(&Error::classified(
                ErrorKind::Configuration,
                "synthetic policy failure"
            )),
            EngineErrorCode::ConfigurationInvalid
        );
    }

    #[test]
    fn cleanup_uncertainty_preserves_the_original_primary_failure() {
        let result = attach_cleanup_status(
            failure(
                EngineErrorCode::NetworkDisconnected,
                StopReason::NetworkUnhealthy,
                Error::classified(ErrorKind::Lifecycle, "synthetic original failure"),
            ),
            true,
        );
        assert_eq!(result.code, EngineErrorCode::NetworkDisconnected);
        assert_eq!(result.stop_reason, StopReason::NetworkUnhealthy);
        assert_eq!(
            result.secondary_code,
            Some(EngineErrorCode::AuthCleanupUnconfirmed)
        );
        assert_eq!(result.error.to_string(), "synthetic original failure");
        let retained = attach_cleanup_status(result, false);
        assert_eq!(
            retained.secondary_code,
            Some(EngineErrorCode::AuthCleanupUnconfirmed)
        );
    }

    #[test]
    fn unsupported_authentication_has_a_distinct_stable_machine_code() {
        use ec_compat::engine::provider::Capability;

        assert_eq!(
            authentication_error_code(&ProviderError::unsupported(Capability::AuthSms)),
            EngineErrorCode::UnsupportedAuthentication
        );
        assert_eq!(
            authentication_error_code(&ProviderError::unsupported(Capability::TransportWebVpn)),
            EngineErrorCode::AuthIndeterminate
        );
        assert_eq!(
            authentication_error_code(&ProviderError::Failed(Error("redacted failure".into()))),
            EngineErrorCode::AuthIndeterminate
        );
        for (kind, code) in [
            (
                ErrorKind::AuthenticationRejected,
                EngineErrorCode::AuthRejected,
            ),
            (
                ErrorKind::AuthenticationIndeterminate,
                EngineErrorCode::AuthIndeterminate,
            ),
            (
                ErrorKind::GatewayPreloginUnavailable,
                EngineErrorCode::GatewayPreloginUnavailable,
            ),
            (
                ErrorKind::AuthenticationProtocolInvalid,
                EngineErrorCode::AuthProtocolInvalid,
            ),
            (
                ErrorKind::AuthenticationExpired,
                EngineErrorCode::AuthExpired,
            ),
            (
                ErrorKind::AuthenticationLimitExceeded,
                EngineErrorCode::AuthLimitExceeded,
            ),
        ] {
            assert_eq!(
                authentication_error_code(&ProviderError::Failed(Error::classified(
                    kind,
                    "redacted authentication failure",
                ))),
                code
            );
        }
        assert_eq!(
            authentication_error_code(&ProviderError::Failed(Error::classified(
                ErrorKind::Configuration,
                "redacted configuration failure",
            ))),
            EngineErrorCode::ConfigurationInvalid
        );
        assert_eq!(
            data_plane_setup_error_code(&Error::classified(
                ErrorKind::Configuration,
                "redacted configuration failure",
            )),
            EngineErrorCode::ConfigurationInvalid
        );
        assert_eq!(
            data_plane_setup_error_code(&Error::classified(
                ErrorKind::DataPlaneTransient,
                "redacted transient failure",
            )),
            EngineErrorCode::DataPlaneSetupTransient
        );
        assert_eq!(
            data_plane_setup_error_code(&Error::classified(
                ErrorKind::DataPlane,
                "redacted permanent failure",
            )),
            EngineErrorCode::DataPlaneSetupFailed
        );

        let failure = authentication_failure(ProviderError::Failed(
            Error::classified(
                ErrorKind::AuthenticationIndeterminate,
                "redacted primary failure",
            )
            .with_cleanup_unconfirmed(),
        ));
        assert_eq!(failure.code, EngineErrorCode::AuthIndeterminate);
        assert_eq!(
            failure.secondary_code,
            Some(EngineErrorCode::AuthCleanupUnconfirmed)
        );
    }
}
