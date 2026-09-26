#[path = "engine_app/arguments.rs"]
mod engine_arguments;
use engine_arguments::{
    EngineArguments, generation_hint, lifecycle_fixture_selected, parse_arguments,
};

use ec_compat::engine::auth_control::{
    AuthControlErrorCode, AuthControlRequest, auth_error_response,
};
use ec_compat::engine::auth_lifecycle::BlockingOperation;
use ec_compat::engine::auth_transaction::AUTH_TRANSACTION_TIMEOUT_MS;
use ec_compat::engine::config_binding::{load_engine_config, read_expected_config_binding};
use ec_compat::engine::control::{
    ControlAction, ControlExchange, ControlSession, MAX_ACTIVE_REQUESTS,
};
use ec_compat::engine::control_mux::{InheritedControlFrameReader, InheritedControlRequest};
use ec_compat::engine::dns::{VpnDnsResolver, VpnDnsSource, select_vpn_dns_servers};
use ec_compat::engine::event::{
    AddressFamily, DnsMode, EngineErrorCode, EngineEvent, EngineEventEmitter, EngineState,
    NetworkUnhealthyReason, StopReason,
};
use ec_compat::engine::ip_packet::stack_mtu;
use ec_compat::engine::netstack::VirtualNetstack;
use ec_compat::engine::provider::{ProviderCapabilityReport, ProviderError};
use ec_compat::engine::provider_composition::{ProductionProviderFamily, ProductionProviderSet};
use ec_compat::engine::proxy::{NameResolver, RejectDomainResolver, SystemDnsResolver};
use ec_compat::engine::session::{AuthenticatedGatewaySession, ModernL3Connection};
use ec_compat::engine::socks::SocksServer;
use ec_compat::engine::socks_auth::{
    EngineCredentials, ProxyAuthentication, ProxyAuthenticationMode, read_engine_credentials,
    read_engine_credentials_prefix,
};
use ec_compat::gateway_connector::GatewayConnectorGeneration;
use ec_compat::{Error, ErrorKind, Result};
use std::io::Write;
use std::net::Ipv4Addr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const CONTROL_SHUTDOWN_CANCEL_WINDOW: Duration = Duration::from_millis(100);
const CONTROL_PREAUTH_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
// A cooperative worker normally observes cancellation between its bounded
// network operations within milliseconds. Do not let an in-flight blocking
// socket outlive Desktop's graceful-control envelope: after this drain window
// the process reports cleanup-unconfirmed and exits fail-closed. The worker
// cannot promote a result because its owner is dropped with the process.
const CONNECTION_OPERATION_CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
const TRANSPORT_BOOTSTRAP_TIMEOUT: Duration = Duration::from_millis(AUTH_TRANSACTION_TIMEOUT_MS);
const NETSTACK_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(feature = "engine-lifecycle-fixture")]
const ENGINE_LIFECYCLE_FIXTURE_MARKER: &str = "HKUSTGZ_TEST_ONLY_ENGINE_LIFECYCLE_V1";
#[cfg(feature = "engine-lifecycle-fixture")]
const ENGINE_LIFECYCLE_FIXTURE_USERNAME: &str = "synthetic-lifecycle-user";
#[cfg(feature = "engine-lifecycle-fixture")]
const ENGINE_LIFECYCLE_FIXTURE_PASSWORD: &str = "synthetic-lifecycle-password";
#[cfg(feature = "engine-lifecycle-fixture")]
const ENGINE_LIFECYCLE_FIXTURE_ADDRESS: Ipv4Addr = Ipv4Addr::new(10, 254, 0, 2);

struct EngineFailure {
    code: EngineErrorCode,
    secondary_code: Option<EngineErrorCode>,
    stop_reason: StopReason,
    error: Error,
}

enum ControlInput {
    V2(ControlExchange),
    V3(AuthControlRequest),
}

#[derive(Default)]
struct PendingControlActions {
    shutdowns: std::collections::BTreeMap<u64, tokio::time::Instant>,
}

#[derive(Clone)]
struct ProviderControlContext {
    profile_id: String,
    profile_revision: u64,
    engine_generation: u64,
    report: ProviderCapabilityReport,
}

impl PendingControlActions {
    fn apply(&mut self, action: ControlAction, now: tokio::time::Instant) -> bool {
        match action {
            ControlAction::Shutdown { request_id } => {
                self.shutdowns
                    .insert(request_id, now + CONTROL_SHUTDOWN_CANCEL_WINDOW);
                false
            }
            ControlAction::Cancel {
                request_to_cancel, ..
            } => {
                self.shutdowns.remove(&request_to_cancel);
                false
            }
            ControlAction::Close { .. } => true,
        }
    }

    fn next_shutdown_deadline(&self) -> Option<tokio::time::Instant> {
        self.shutdowns.values().copied().min()
    }
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

    fn with_secondary_code(mut self, secondary_code: Option<EngineErrorCode>) -> Self {
        self.secondary_code = secondary_code;
        self
    }
}

type EngineResult<T> = std::result::Result<T, EngineFailure>;

struct EngineLifecycle<W> {
    events: EngineEventEmitter<W>,
    generation: u64,
    phase: Option<EngineState>,
}

impl<W: Write> EngineLifecycle<W> {
    fn new(writer: W, generation: u64) -> Self {
        Self {
            events: EngineEventEmitter::new(writer),
            generation,
            phase: None,
        }
    }

    fn emit(&mut self, event: EngineEvent) -> Result<()> {
        self.events.emit(&event)
    }

    fn emit_control(&mut self, exchange: &ControlExchange) -> Result<()> {
        self.events.emit_control(&exchange.response)
    }

    fn reject_auth_control(&mut self, request: &AuthControlRequest) -> Result<()> {
        self.events.emit_auth_control(&auth_error_response(
            request.request_id(),
            AuthControlErrorCode::TransactionClosed,
        ))
    }

    fn state(&mut self, state: EngineState) -> Result<()> {
        let allowed = matches!(
            (self.phase, state),
            (None, EngineState::Connecting | EngineState::Stopping)
                | (
                    Some(EngineState::Connecting),
                    EngineState::Authenticating | EngineState::Stopping
                )
                | (
                    Some(EngineState::Authenticating),
                    EngineState::PreparingTunnel | EngineState::Stopping
                )
                | (
                    Some(EngineState::PreparingTunnel),
                    EngineState::Connected | EngineState::Stopping
                )
                | (Some(EngineState::Connected), EngineState::Stopping)
                | (Some(EngineState::Stopping), EngineState::Stopped)
        );
        if !allowed {
            return Err(Error::classified(
                ErrorKind::Lifecycle,
                "invalid engine lifecycle transition",
            ));
        }
        self.phase = Some(state);
        self.emit(EngineEvent::StateChanged {
            state,
            generation: self.generation,
        })
    }

    fn begin_stopping(&mut self) -> Result<()> {
        if matches!(
            self.phase,
            Some(EngineState::Stopping | EngineState::Stopped)
        ) {
            return Ok(());
        }
        self.state(EngineState::Stopping)
    }

    fn finish(&mut self, reason: StopReason) -> Result<()> {
        self.begin_stopping()?;
        self.state(EngineState::Stopped)?;
        self.emit(EngineEvent::Stopped {
            reason,
            generation: self.generation,
        })
    }
}

fn start_control_reader(
    provider_context: Option<ProviderControlContext>,
) -> Result<tokio::sync::mpsc::Receiver<ControlInput>> {
    let (sender, receiver) = tokio::sync::mpsc::channel(MAX_ACTIVE_REQUESTS);
    std::thread::Builder::new()
        .name("ec-engine-control".into())
        .spawn(move || {
            let stdin = std::io::stdin();
            if control_reader_loop(stdin.lock(), sender, provider_context).is_err() {
                // Framing errors are intentionally generic: never echo a raw
                // control line that might have been supplied by a faulty
                // caller. EOF is a normal control-channel close and does not
                // reach this branch or stop the engine.
                eprintln!("ec-engine: invalid engine control frame; control channel closed");
            }
        })
        .map_err(|_| Error("engine control reader could not start".into()))?;
    Ok(receiver)
}

fn control_reader_loop<R: std::io::Read>(
    reader: R,
    sender: tokio::sync::mpsc::Sender<ControlInput>,
    provider_context: Option<ProviderControlContext>,
) -> Result<()> {
    let mut reader = InheritedControlFrameReader::new(reader);
    let mut session = match provider_context {
        Some(context) => ControlSession::with_provider_capabilities(
            context.profile_id,
            context.profile_revision,
            context.engine_generation,
            context.report,
        )?,
        None => ControlSession::new(),
    };
    while let Some(request) = reader.read_request()? {
        let (input, closes_channel) = match request {
            InheritedControlRequest::V2(request) => {
                let exchange = session.handle(request);
                let closes_channel = matches!(exchange.action, Some(ControlAction::Close { .. }));
                (ControlInput::V2(exchange), closes_channel)
            }
            InheritedControlRequest::V3(request) => (ControlInput::V3(request), false),
        };
        if sender.blocking_send(input).is_err() {
            return Ok(());
        }
        if closes_channel {
            return Ok(());
        }
    }
    Ok(())
}

fn failure(code: EngineErrorCode, stop_reason: StopReason, error: Error) -> EngineFailure {
    EngineFailure::new(code, stop_reason, error)
}

fn event_output_failure(error: Error) -> EngineFailure {
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

fn gateway_connector_error_code(error: &Error) -> EngineErrorCode {
    match error.kind() {
        ErrorKind::Configuration => EngineErrorCode::ConfigurationInvalid,
        ErrorKind::GatewayHttp => EngineErrorCode::GatewayPreloginUnavailable,
        _ => EngineErrorCode::AuthIndeterminate,
    }
}

fn authentication_failure(error: ProviderError) -> EngineFailure {
    let code = authentication_error_code(&error);
    let cleanup_unconfirmed = matches!(
        &error,
        ProviderError::Failed(error) if error.cleanup_unconfirmed()
    );
    failure(code, StopReason::StartupFailed, Error::from(error))
        .with_secondary_code(cleanup_unconfirmed.then_some(EngineErrorCode::AuthCleanupUnconfirmed))
}

fn data_plane_setup_error_code(error: &Error) -> EngineErrorCode {
    match error.kind() {
        ErrorKind::Configuration => EngineErrorCode::ConfigurationInvalid,
        ErrorKind::DataPlaneTransient => EngineErrorCode::DataPlaneSetupTransient,
        _ => EngineErrorCode::DataPlaneSetupFailed,
    }
}

fn failure_preserving_cleanup(
    code: EngineErrorCode,
    stop_reason: StopReason,
    error: Error,
) -> EngineFailure {
    let cleanup_unconfirmed = error.cleanup_unconfirmed();
    failure(code, stop_reason, error)
        .with_secondary_code(cleanup_unconfirmed.then_some(EngineErrorCode::AuthCleanupUnconfirmed))
}

fn failure_after_gateway_cleanup(
    session: AuthenticatedGatewaySession,
    failure: EngineFailure,
) -> EngineFailure {
    if session.logout().is_err() {
        failure.with_secondary_code(Some(EngineErrorCode::AuthCleanupUnconfirmed))
    } else {
        failure
    }
}

enum GatewayCleanup {
    Production(AuthenticatedGatewaySession),
    #[cfg(feature = "engine-lifecycle-fixture")]
    LifecycleFixture,
}

impl GatewayCleanup {
    fn logout(self, _netstack: &VirtualNetstack) -> Result<()> {
        match self {
            Self::Production(session) => session.logout(),
            #[cfg(feature = "engine-lifecycle-fixture")]
            Self::LifecycleFixture => {
                if _netstack.lifecycle_fixture_shutdown_complete() {
                    Ok(())
                } else {
                    Err(Error::classified(
                        ErrorKind::Lifecycle,
                        "lifecycle fixture cleanup ran before netstack shutdown completed",
                    ))
                }
            }
        }
    }
}

async fn failure_after_runtime_cleanup(
    netstack: &VirtualNetstack,
    cleanup: GatewayCleanup,
    failure: EngineFailure,
) -> EngineFailure {
    if let Err(error) = netstack.shutdown(NETSTACK_SHUTDOWN_TIMEOUT).await {
        // Preserve the earlier primary failure. Event v1 intentionally has only
        // one secondary slot, reserved for remote Gateway cleanup uncertainty.
        eprintln!("ec-engine: {error}");
    }
    if cleanup.logout(netstack).is_err() {
        failure.with_secondary_code(Some(EngineErrorCode::AuthCleanupUnconfirmed))
    } else {
        failure
    }
}

fn configured_vpn_dns_servers(config: &serde_json::Value) -> Result<Vec<Ipv4Addr>> {
    let Some(value) = config.pointer("/proxy/vpn_dns_servers") else {
        return Ok(Vec::new());
    };
    let entries = value
        .as_array()
        .ok_or_else(|| Error("configured VPN DNS servers must be an array".into()))?;
    let mut servers = Vec::with_capacity(entries.len());
    for entry in entries {
        let server = entry
            .as_str()
            .and_then(|value| value.parse::<Ipv4Addr>().ok())
            .ok_or_else(|| Error("configured VPN DNS server is not a valid IPv4 address".into()))?;
        if !servers.contains(&server) {
            servers.push(server);
        }
    }
    // Validate the deployment profile before authentication so a malformed or
    // unsafe packaged address cannot open a remote session first.
    let _ = select_vpn_dns_servers(&[], &servers)?;
    Ok(servers)
}

#[cfg(feature = "engine-lifecycle-fixture")]
fn validate_lifecycle_fixture_dns_isolation(
    config: &serde_json::Value,
    profile_dns_servers: &[Ipv4Addr],
) -> Result<()> {
    if config["proxy"]["allow_system_dns_fallback"]
        .as_bool()
        .unwrap_or(false)
        || !profile_dns_servers.is_empty()
    {
        return Err(Error::classified(
            ErrorKind::Configuration,
            "lifecycle fixture requires DNS to remain disabled",
        ));
    }
    Ok(())
}

fn dns_mode_for_source(source: VpnDnsSource) -> DnsMode {
    match source {
        VpnDnsSource::Gateway => DnsMode::Gateway,
        VpnDnsSource::Profile => DnsMode::VpnProfile,
        VpnDnsSource::GatewayAndProfile => DnsMode::GatewayProfile,
    }
}

enum ConnectionOperationCancellationCause {
    UserRequested,
    DeadlineExpired,
    SignalFailed(Error),
    ControlOutputFailed(Error),
}

enum ConnectionOperationOutcome<S, E> {
    Completed(std::result::Result<S, E>),
    WorkerFailed(Error),
    Cancelled {
        cause: ConnectionOperationCancellationCause,
        completion: Result<std::result::Result<S, E>>,
    },
}

async fn drive_blocking_connection_operation<S, E, W: Write>(
    operation: &mut BlockingOperation<S, E>,
    deadline: tokio::time::Instant,
    control_receiver: &mut Option<tokio::sync::mpsc::Receiver<ControlInput>>,
    pending_control_actions: &mut PendingControlActions,
    lifecycle: &mut EngineLifecycle<W>,
) -> ConnectionOperationOutcome<S, E>
where
    S: Send + 'static,
    E: Send + 'static,
{
    let signal = shutdown_signal();
    tokio::pin!(signal);
    let cause = loop {
        let control_shutdown_deadline = pending_control_actions.next_shutdown_deadline();
        tokio::select! {
            // Promotion is the lowest-priority outcome.  If a blocking worker
            // finishes at the same instant as its owner closes the private
            // control pipe (or a previously accepted shutdown commits), the
            // stop boundary must win so a stale Auth/Transport result cannot
            // be promoted into listener resources.
            biased;
            _ = wait_for_control_shutdown(control_shutdown_deadline), if control_shutdown_deadline.is_some() => {
                break ConnectionOperationCancellationCause::UserRequested;
            }
            signal = &mut signal => {
                break match signal {
                    Ok(()) => ConnectionOperationCancellationCause::UserRequested,
                    Err(error) => ConnectionOperationCancellationCause::SignalFailed(error),
                };
            }
            _ = tokio::time::sleep_until(deadline) => {
                break ConnectionOperationCancellationCause::DeadlineExpired;
            }
            input = receive_control(control_receiver), if control_receiver.is_some() => {
                let Some(input) = input else {
                    // Before listener readiness, the inherited private pipe is
                    // part of the connection-attempt owner boundary. Losing it
                    // cancels auth or transport so no session continues without
                    // its generation controller.
                    *control_receiver = None;
                    break ConnectionOperationCancellationCause::UserRequested;
                };
                match input {
                    ControlInput::V2(exchange) => {
                        if let Err(error) = lifecycle.emit_control(&exchange) {
                            break ConnectionOperationCancellationCause::ControlOutputFailed(error);
                        }
                        if let Some(action) = exchange.action
                            && pending_control_actions.apply(action, tokio::time::Instant::now())
                        {
                            *control_receiver = None;
                            break ConnectionOperationCancellationCause::UserRequested;
                        }
                    }
                    ControlInput::V3(request) => {
                        if let Err(error) = lifecycle.reject_auth_control(&request) {
                            break ConnectionOperationCancellationCause::ControlOutputFailed(error);
                        }
                    }
                }
            }
            completion = operation.wait() => {
                return match completion {
                    Ok(result) => ConnectionOperationOutcome::Completed(result),
                    Err(error) => ConnectionOperationOutcome::WorkerFailed(error),
                };
            }
        }
    };

    operation.cancel();
    let completion =
        match tokio::time::timeout(CONNECTION_OPERATION_CANCEL_DRAIN_TIMEOUT, operation.wait())
            .await
        {
            Ok(completion) => completion,
            Err(_) => Err(Error::classified(
                ErrorKind::Lifecycle,
                "connection operation did not stop within its cancellation drain deadline",
            )),
        };
    ConnectionOperationOutcome::Cancelled { cause, completion }
}

fn attach_cleanup_status(failure: EngineFailure, cleanup_unconfirmed: bool) -> EngineFailure {
    if cleanup_unconfirmed {
        failure.with_secondary_code(Some(EngineErrorCode::AuthCleanupUnconfirmed))
    } else {
        failure
    }
}

fn cancelled_connection_attempt_failure(message: &'static str) -> EngineFailure {
    attach_cleanup_status(
        failure(
            EngineErrorCode::LogoutFailed,
            StopReason::LogoutFailed,
            Error::classified(ErrorKind::Lifecycle, message),
        ),
        true,
    )
}

async fn authenticate_password_with_lifecycle<W: Write>(
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

async fn prepare_transport_with_lifecycle<W: Write>(
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

#[tokio::main]
async fn main() {
    let exit_code = engine_main().await;
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}

async fn engine_main() -> i32 {
    let raw_args = std::env::args().skip(1).collect::<Vec<_>>();
    let parsed_args = parse_arguments(&raw_args);
    let generation = parsed_args
        .as_ref()
        .map(|arguments| arguments.generation)
        .unwrap_or_else(|_| generation_hint(&raw_args));
    let stdout = std::io::stdout();
    let mut lifecycle = EngineLifecycle::new(stdout.lock(), generation);
    if let Err(error) = lifecycle.emit(EngineEvent::hello()) {
        eprintln!("ec-engine: {error}");
        return 1;
    }

    let result = match parsed_args {
        Ok(arguments) => run_engine(&arguments, &mut lifecycle).await,
        Err(error) => Err(failure(
            EngineErrorCode::InvalidArguments,
            StopReason::StartupFailed,
            error,
        )),
    };
    match result {
        Ok(reason) => match lifecycle.finish(reason) {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("ec-engine: {error}");
                1
            }
        },
        Err(failure) => {
            eprintln!("ec-engine: {}", failure.error);
            if let Err(error) = lifecycle.begin_stopping() {
                eprintln!("ec-engine: {error}");
            }
            if let Err(error) = lifecycle.emit(EngineEvent::FatalError {
                code: failure.code,
                secondary_code: failure.secondary_code,
            }) {
                eprintln!("ec-engine: {error}");
            }
            if let Err(error) = lifecycle.finish(failure.stop_reason) {
                eprintln!("ec-engine: {error}");
            }
            1
        }
    }
}

async fn run_engine<W: Write>(
    arguments: &EngineArguments,
    lifecycle: &mut EngineLifecycle<W>,
) -> EngineResult<StopReason> {
    lifecycle
        .state(EngineState::Connecting)
        .map_err(event_output_failure)?;
    let stdin = std::io::stdin();
    let mut inherited_stdin = stdin.lock();
    let config_binding = if arguments.profile_binding_v1_stdin {
        Some(
            read_expected_config_binding(&mut inherited_stdin).map_err(|_| {
                failure(
                    EngineErrorCode::ConfigurationInvalid,
                    StopReason::StartupFailed,
                    Error("engine configuration binding is invalid".into()),
                )
            })?,
        )
    } else {
        None
    };
    let config = load_engine_config(Path::new(&arguments.config), config_binding.as_ref())
        .map_err(|_| {
            failure(
                EngineErrorCode::ConfigurationInvalid,
                StopReason::StartupFailed,
                Error("engine configuration could not be loaded or is invalid".into()),
            )
        })?;
    let profile_dns_servers = configured_vpn_dns_servers(&config).map_err(|_| {
        failure(
            EngineErrorCode::ConfigurationInvalid,
            StopReason::StartupFailed,
            Error("engine VPN DNS configuration is invalid".into()),
        )
    })?;
    let gateway_connector = if let Some(binding) = config_binding
        .as_ref()
        .filter(|_| !lifecycle_fixture_selected(arguments))
    {
        let base_url = config["base_url"].as_str().ok_or_else(|| {
            failure(
                EngineErrorCode::ConfigurationInvalid,
                StopReason::StartupFailed,
                Error("engine Gateway connector origin is invalid".into()),
            )
        })?;
        let private_allowed = config["gateway_connector"]["reviewed_private_gateway_allowed"]
            .as_bool()
            .ok_or_else(|| {
                failure(
                    EngineErrorCode::ConfigurationInvalid,
                    StopReason::StartupFailed,
                    Error("engine Gateway connector policy is invalid".into()),
                )
            })?;
        Some(Arc::new(
            GatewayConnectorGeneration::resolve_system(
                binding.profile_id(),
                binding.profile_revision(),
                arguments.generation,
                base_url,
                private_allowed,
            )
            .and_then(|connector| {
                match (
                    arguments.source_interface.as_deref(),
                    arguments.source_address,
                ) {
                    (Some(interface), Some(address)) => connector.with_underlay(interface, address),
                    (None, None) => Ok(connector),
                    _ => unreachable!(),
                }
            })
            .map_err(|error| {
                failure(
                    gateway_connector_error_code(&error),
                    StopReason::StartupFailed,
                    error,
                )
            })?,
        ))
    } else {
        None
    };

    lifecycle
        .state(EngineState::Authenticating)
        .map_err(event_output_failure)?;
    let credentials = if arguments.control_api_v2_stdin {
        read_engine_credentials_prefix(&mut inherited_stdin, arguments.proxy_authentication_mode)
    } else {
        read_engine_credentials(&mut inherited_stdin, arguments.proxy_authentication_mode)
    }
    .map_err(|error| {
        failure(
            EngineErrorCode::CredentialsInvalid,
            StopReason::StartupFailed,
            error,
        )
    })?;
    let provider_family = config_binding
        .as_ref()
        .map(|binding| binding.protocol_family())
        .unwrap_or(ProductionProviderFamily::EasyConnectPasswordModernL3V1);
    let provider_control_context = config_binding
        .as_ref()
        .map(|binding| {
            provider_family
                .capability_report()
                .map(|report| ProviderControlContext {
                    profile_id: binding.profile_id().to_owned(),
                    profile_revision: binding.profile_revision(),
                    engine_generation: arguments.generation,
                    report,
                })
        })
        .transpose()
        .map_err(|_| {
            failure(
                EngineErrorCode::ConfigurationInvalid,
                StopReason::StartupFailed,
                Error("engine provider capability composition is invalid".into()),
            )
        })?;
    drop(inherited_stdin);
    let mut control_receiver = if arguments.control_api_v2_stdin {
        Some(
            start_control_reader(provider_control_context).map_err(|error| {
                failure(
                    EngineErrorCode::LocalListenerFailed,
                    StopReason::StartupFailed,
                    error,
                )
            })?,
        )
    } else {
        None
    };
    let had_control_channel = control_receiver.is_some();
    emit_initial_control_exchange(&mut control_receiver, lifecycle).await?;
    if had_control_channel && control_receiver.is_none() {
        lifecycle.begin_stopping().map_err(event_output_failure)?;
        return Ok(StopReason::UserRequested);
    }
    // Accepted control actions belong to the whole connection attempt, not one
    // phase. A shutdown acknowledged just before Auth or Transport completes
    // must remain pending in the next phase until its cancellation window ends.
    let mut pending_control_actions = PendingControlActions::default();
    let EngineCredentials {
        gateway_username,
        gateway_password,
        proxy_authentication,
    } = credentials;
    #[cfg(feature = "engine-lifecycle-fixture")]
    if arguments.lifecycle_fixture {
        if let Err(error) = validate_lifecycle_fixture_dns_isolation(&config, &profile_dns_servers)
        {
            return Err(failure(
                EngineErrorCode::ConfigurationInvalid,
                StopReason::StartupFailed,
                error,
            ));
        }
        if gateway_username.as_str() != ENGINE_LIFECYCLE_FIXTURE_USERNAME
            || gateway_password.as_str() != ENGINE_LIFECYCLE_FIXTURE_PASSWORD
        {
            return Err(failure(
                EngineErrorCode::CredentialsInvalid,
                StopReason::StartupFailed,
                Error::classified(
                    ErrorKind::Credentials,
                    "lifecycle fixture credentials are invalid",
                ),
            ));
        }
        lifecycle
            .state(EngineState::PreparingTunnel)
            .map_err(event_output_failure)?;
        // This fixed marker is also a packaging tripwire. It contains no
        // credential, endpoint, token, or vendor protocol material.
        eprintln!("{ENGINE_LIFECYCLE_FIXTURE_MARKER}");
        let mtu = stack_mtu(config["tunnel"]["mtu"].as_u64());
        let netstack =
            VirtualNetstack::start_lifecycle_fixture(ENGINE_LIFECYCLE_FIXTURE_ADDRESS, mtu)
                .map(Arc::new)
                .map_err(|error| {
                    failure(
                        EngineErrorCode::DataPlaneSetupFailed,
                        StopReason::StartupFailed,
                        error,
                    )
                })?;
        return serve_prepared_netstack(
            arguments,
            lifecycle,
            &config,
            &profile_dns_servers,
            &[],
            proxy_authentication,
            &mut control_receiver,
            &mut pending_control_actions,
            netstack,
            GatewayCleanup::LifecycleFixture,
            mtu,
        )
        .await;
    }
    let providers = match gateway_connector {
        Some(connector) => {
            ProductionProviderSet::from_config_with_connector(provider_family, &config, connector)
        }
        None => ProductionProviderSet::from_config(provider_family, &config),
    }
    .map_err(|_| {
        failure(
            EngineErrorCode::ConfigurationInvalid,
            StopReason::StartupFailed,
            Error("engine provider composition is invalid".into()),
        )
    })?;
    let Some(session) = authenticate_password_with_lifecycle(
        &providers,
        gateway_username,
        gateway_password,
        &mut control_receiver,
        &mut pending_control_actions,
        lifecycle,
    )
    .await?
    else {
        return Ok(StopReason::UserRequested);
    };

    if let Err(error) = lifecycle.state(EngineState::PreparingTunnel) {
        return Err(failure_after_gateway_cleanup(
            session,
            event_output_failure(error),
        ));
    }

    let Some((session, transport)) = prepare_transport_with_lifecycle(
        &providers,
        session,
        &mut control_receiver,
        &mut pending_control_actions,
        lifecycle,
    )
    .await?
    else {
        return Ok(StopReason::UserRequested);
    };
    let gateway_dns_servers = transport.dns_servers().to_vec();
    let data_plane = transport.into_data_plane();
    let mtu = stack_mtu(config["tunnel"]["mtu"].as_u64());
    let netstack = match VirtualNetstack::start(data_plane, mtu) {
        Ok(netstack) => Arc::new(netstack),
        Err(error) => {
            let failure = failure(
                EngineErrorCode::DataPlaneSetupFailed,
                StopReason::StartupFailed,
                error,
            );
            return Err(failure_after_gateway_cleanup(session, failure));
        }
    };
    serve_prepared_netstack(
        arguments,
        lifecycle,
        &config,
        &profile_dns_servers,
        &gateway_dns_servers,
        proxy_authentication,
        &mut control_receiver,
        &mut pending_control_actions,
        netstack,
        GatewayCleanup::Production(session),
        mtu,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn serve_prepared_netstack<W: Write>(
    arguments: &EngineArguments,
    lifecycle: &mut EngineLifecycle<W>,
    config: &serde_json::Value,
    profile_dns_servers: &[Ipv4Addr],
    gateway_dns_servers: &[Ipv4Addr],
    proxy_authentication: ProxyAuthentication,
    control_receiver: &mut Option<tokio::sync::mpsc::Receiver<ControlInput>>,
    pending_control_actions: &mut PendingControlActions,
    netstack: Arc<VirtualNetstack>,
    cleanup: GatewayCleanup,
    mtu: usize,
) -> EngineResult<StopReason> {
    let health = Arc::clone(&netstack);
    let allow_system_dns_fallback = config["proxy"]["allow_system_dns_fallback"]
        .as_bool()
        .unwrap_or(false);
    let vpn_dns = match select_vpn_dns_servers(gateway_dns_servers, profile_dns_servers) {
        Ok(selection) => selection,
        Err(error) => {
            let failure = failure(
                EngineErrorCode::DataPlaneSetupFailed,
                StopReason::StartupFailed,
                error,
            );
            return Err(failure_after_runtime_cleanup(&netstack, cleanup, failure).await);
        }
    };
    let (resolver, dns_mode): (Arc<dyn NameResolver>, DnsMode) = if let Some(selection) = vpn_dns {
        let dns_mode = dns_mode_for_source(selection.source());
        let resolver = match VpnDnsResolver::new(
            Arc::clone(&netstack),
            selection.into_servers(),
            Duration::from_secs(5),
        ) {
            Ok(resolver) => resolver,
            Err(error) => {
                let failure = failure(
                    EngineErrorCode::DataPlaneSetupFailed,
                    StopReason::StartupFailed,
                    error,
                );
                return Err(failure_after_runtime_cleanup(&netstack, cleanup, failure).await);
            }
        };
        (Arc::new(resolver), dns_mode)
    } else if allow_system_dns_fallback {
        (Arc::new(SystemDnsResolver), DnsMode::SystemFallback)
    } else {
        (Arc::new(RejectDomainResolver), DnsMode::Disabled)
    };
    let server = match SocksServer::new_with_authentication(
        arguments.bind,
        Arc::clone(&netstack),
        resolver,
        proxy_authentication,
    ) {
        Ok(server) => server,
        Err(error) => {
            let failure = failure(
                EngineErrorCode::LocalListenerFailed,
                StopReason::StartupFailed,
                error,
            );
            return Err(failure_after_runtime_cleanup(&netstack, cleanup, failure).await);
        }
    };
    let server = match server.bind().await {
        Ok(server) => server,
        Err(error) => {
            let failure = failure(
                EngineErrorCode::LocalListenerFailed,
                StopReason::StartupFailed,
                error,
            );
            return Err(failure_after_runtime_cleanup(&netstack, cleanup, failure).await);
        }
    };

    let metadata_result = (|| -> Result<()> {
        lifecycle.emit(EngineEvent::ClientIpAssigned {
            family: AddressFamily::Ipv4,
            address: netstack.assigned_address(),
        })?;
        lifecycle.emit(EngineEvent::DnsMode { mode: dns_mode })?;
        lifecycle.emit(EngineEvent::ListenerReady {
            port: arguments.bind.port(),
        })?;
        Ok(())
    })();
    if let Err(error) = metadata_result {
        let failure = event_output_failure(error);
        return Err(failure_after_runtime_cleanup(&netstack, cleanup, failure).await);
    }

    // These preserve human-readable diagnostics and the old desktop fallback,
    // but stderr is never part of the NDJSON protocol.
    eprintln!("Client IP assigned");
    eprintln!("Proxy DNS mode: {}", dns_mode.diagnostic_name());
    eprintln!("Tunnel MTU: {mtu}");
    match arguments.proxy_authentication_mode {
        ProxyAuthenticationMode::Required => eprintln!(
            "local proxy listening on {} (authenticated SOCKS5 TCP + HTTP CONNECT/HTTP/WS; UDP ASSOCIATE disabled)",
            arguments.bind
        ),
        ProxyAuthenticationMode::Optional => eprintln!(
            "SOCKS5 server listening on {} (optional RFC 1929; NO_AUTH keeps UDP compatibility)",
            arguments.bind
        ),
        ProxyAuthenticationMode::None => eprintln!(
            "SOCKS5 server listening on {} (TCP CONNECT + UDP ASSOCIATE)",
            arguments.bind
        ),
    }

    let mut services = tokio::task::JoinSet::new();
    services.spawn(async move {
        server
            .serve()
            .await
            .map_err(|error| Error(format!("SOCKS5 service failed: {error}")))
    });
    if let Err(error) = lifecycle.state(EngineState::Connected) {
        abort_and_drain_services(&mut services).await;
        let failure = event_output_failure(error);
        return Err(failure_after_runtime_cleanup(&netstack, cleanup, failure).await);
    }

    let shutdown = {
        let service_exit = async {
            match services.join_next().await {
                Some(Ok(Ok(()))) => Error("local proxy service stopped unexpectedly".into()),
                Some(Ok(Err(error))) => error,
                Some(Err(_)) => Error("local proxy service task failed".into()),
                None => Error("all local proxy services stopped unexpectedly".into()),
            }
        };
        tokio::pin!(service_exit);
        let signal = shutdown_signal();
        tokio::pin!(signal);
        let unhealthy = wait_for_unhealthy(health);
        tokio::pin!(unhealthy);
        loop {
            let control_shutdown_deadline = pending_control_actions.next_shutdown_deadline();
            match select_serving_event(
                control_shutdown_deadline,
                signal.as_mut(),
                service_exit.as_mut(),
                unhealthy.as_mut(),
                control_receiver,
            )
            .await
            {
                ServingEvent::ControlShutdownCommitted => break ShutdownCause::UserRequested,
                ServingEvent::Signal(signal) => {
                    break match signal {
                        Ok(()) => ShutdownCause::UserRequested,
                        Err(error) => ShutdownCause::SignalFailed(error),
                    };
                }
                ServingEvent::LocalServiceFailed(error) => {
                    break ShutdownCause::LocalServiceFailed(error);
                }
                ServingEvent::NetworkDisconnected => break ShutdownCause::NetworkDisconnected,
                ServingEvent::Control(exchange) => {
                    let Some(input) = exchange else {
                        // Closing the inherited stdin control stream is not a
                        // request to stop the VPN. Signal/process supervision
                        // remains the legacy-compatible shutdown path.
                        *control_receiver = None;
                        continue;
                    };
                    match input {
                        ControlInput::V2(exchange) => {
                            if let Err(error) = lifecycle.emit_control(&exchange) {
                                break ShutdownCause::ControlOutputFailed(error);
                            }
                            if exchange.action.is_some_and(|action| {
                                pending_control_actions.apply(action, tokio::time::Instant::now())
                            }) {
                                *control_receiver = None;
                            }
                        }
                        ControlInput::V3(request) => {
                            // The production provider is password-only today.
                            // A v3 frame is accepted by the private transport,
                            // but cannot manufacture or resume a transaction.
                            if let Err(error) = lifecycle.reject_auth_control(&request) {
                                break ShutdownCause::ControlOutputFailed(error);
                            }
                        }
                    }
                }
            }
        }
    };
    // Listener ownership and its outer serving task are gone before the
    // netstack closes its sockets and joins the runner/bridges. Gateway logout
    // is deliberately last so no local request races session teardown.
    abort_and_drain_services(&mut services).await;

    let unhealthy_event_error = if matches!(&shutdown, ShutdownCause::NetworkDisconnected) {
        lifecycle
            .emit(EngineEvent::NetworkUnhealthy {
                reason: NetworkUnhealthyReason::DataPlaneDisconnected,
            })
            .err()
    } else {
        None
    };
    let stopping_error = lifecycle.begin_stopping().err();
    let netstack_shutdown = netstack.shutdown(NETSTACK_SHUTDOWN_TIMEOUT).await;
    let logout = cleanup.logout(&netstack);
    if let Some(error) = unhealthy_event_error.or(stopping_error) {
        if let Err(netstack_error) = netstack_shutdown {
            eprintln!("ec-engine: {netstack_error}");
        }
        return Err(attach_cleanup_status(
            event_output_failure(error),
            logout.is_err(),
        ));
    }
    if let Err(error) = netstack_shutdown {
        if !matches!(&shutdown, ShutdownCause::UserRequested) {
            // A signal, local-service, network, or control-output failure was
            // observed first and remains the primary cause. Event v1 has no
            // general secondary-error list, so retain the shutdown detail only
            // in redacted diagnostics.
            eprintln!("ec-engine: {error}");
        } else {
            return Err(attach_cleanup_status(
                failure(
                    EngineErrorCode::DataPlaneShutdownFailed,
                    StopReason::ShutdownFailed,
                    error,
                ),
                logout.is_err(),
            ));
        }
    }

    match shutdown {
        ShutdownCause::UserRequested => {
            logout.map(|_| StopReason::UserRequested).map_err(|error| {
                failure(
                    EngineErrorCode::LogoutFailed,
                    StopReason::LogoutFailed,
                    error,
                )
            })
        }
        ShutdownCause::SignalFailed(error) => Err(attach_cleanup_status(
            failure(
                EngineErrorCode::ShutdownSignalFailed,
                StopReason::ShutdownFailed,
                error,
            ),
            logout.is_err(),
        )),
        ShutdownCause::LocalServiceFailed(error) => Err(attach_cleanup_status(
            failure(
                EngineErrorCode::LocalListenerFailed,
                StopReason::LocalServiceFailed,
                error,
            ),
            logout.is_err(),
        )),
        ShutdownCause::NetworkDisconnected => Err(attach_cleanup_status(
            failure(
                EngineErrorCode::NetworkDisconnected,
                StopReason::NetworkUnhealthy,
                Error("VPN data plane disconnected".into()),
            ),
            logout.is_err(),
        )),
        ShutdownCause::ControlOutputFailed(error) => Err(attach_cleanup_status(
            event_output_failure(error),
            logout.is_err(),
        )),
    }
}

async fn receive_control(
    receiver: &mut Option<tokio::sync::mpsc::Receiver<ControlInput>>,
) -> Option<ControlInput> {
    match receiver {
        Some(receiver) => receiver.recv().await,
        None => std::future::pending().await,
    }
}

async fn abort_and_drain_services(services: &mut tokio::task::JoinSet<Result<()>>) {
    services.abort_all();
    while services.join_next().await.is_some() {}
}

async fn emit_initial_control_exchange<W: Write>(
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

async fn wait_for_control_shutdown(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

enum ServingEvent {
    ControlShutdownCommitted,
    Signal(Result<()>),
    LocalServiceFailed(Error),
    NetworkDisconnected,
    Control(Option<ControlInput>),
}

async fn select_serving_event<S, L, H>(
    control_shutdown_deadline: Option<tokio::time::Instant>,
    signal: std::pin::Pin<&mut S>,
    service_exit: std::pin::Pin<&mut L>,
    unhealthy: std::pin::Pin<&mut H>,
    control_receiver: &mut Option<tokio::sync::mpsc::Receiver<ControlInput>>,
) -> ServingEvent
where
    S: std::future::Future<Output = Result<()>>,
    L: std::future::Future<Output = Error>,
    H: std::future::Future<Output = ()>,
{
    // A Tokio timer whose deadline has already elapsed may need one poll to
    // register with the time driver. Resolve the committed state explicitly so
    // an already-ready lower-priority future cannot overtake it on that poll.
    if control_shutdown_deadline.is_some_and(|deadline| deadline <= tokio::time::Instant::now()) {
        return ServingEvent::ControlShutdownCommitted;
    }
    tokio::select! {
        // Keep simultaneous terminal causes deterministic. A committed user
        // shutdown outranks incidental health/service failure; passive control
        // frames remain lowest priority and cannot starve a ready terminal
        // condition. This order is covered by a simultaneous-readiness test.
        biased;
        _ = wait_for_control_shutdown(control_shutdown_deadline), if control_shutdown_deadline.is_some() => {
            ServingEvent::ControlShutdownCommitted
        }
        signal = signal => ServingEvent::Signal(signal),
        error = service_exit => ServingEvent::LocalServiceFailed(error),
        _ = unhealthy => ServingEvent::NetworkDisconnected,
        exchange = receive_control(control_receiver), if control_receiver.is_some() => {
            ServingEvent::Control(exchange)
        }
    }
}

enum ShutdownCause {
    UserRequested,
    SignalFailed(Error),
    LocalServiceFailed(Error),
    NetworkDisconnected,
    ControlOutputFailed(Error),
}

#[cfg(unix)]
async fn shutdown_signal() -> Result<()> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut terminate = signal(SignalKind::terminate())
        .map_err(|_| Error("cannot install termination signal handler".into()))?;
    tokio::select! {
        signal = tokio::signal::ctrl_c() => {
            signal.map_err(|_| Error("cannot install interrupt signal handler".into()))
        }
        _ = terminate.recv() => Ok(()),
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() -> Result<()> {
    tokio::signal::ctrl_c()
        .await
        .map_err(|_| Error("cannot install interrupt signal handler".into()))
}

async fn wait_for_unhealthy(netstack: Arc<VirtualNetstack>) {
    while netstack.is_healthy() {
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deployment_profile_dns_is_strict_bounded_and_source_typed() {
        let config = serde_json::json!({
            "proxy": {
                "vpn_dns_servers": ["10.90.63.2", "10.90.63.3", "10.90.63.2"]
            }
        });
        assert_eq!(
            configured_vpn_dns_servers(&config).unwrap(),
            [Ipv4Addr::new(10, 90, 63, 2), Ipv4Addr::new(10, 90, 63, 3),]
        );
        assert_eq!(
            dns_mode_for_source(VpnDnsSource::Profile),
            DnsMode::VpnProfile
        );
        assert_eq!(
            dns_mode_for_source(VpnDnsSource::GatewayAndProfile),
            DnsMode::GatewayProfile
        );

        for invalid in [
            serde_json::json!({"proxy": {"vpn_dns_servers": "10.90.63.2"}}),
            serde_json::json!({"proxy": {"vpn_dns_servers": ["not-an-address"]}}),
            serde_json::json!({"proxy": {"vpn_dns_servers": ["127.0.0.1"]}}),
        ] {
            assert!(configured_vpn_dns_servers(&invalid).is_err());
        }
    }

    #[test]
    fn hkustgz_production_profile_keeps_split_dns_inside_the_vpn() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../config/hkustgz.json")).unwrap();
        assert_eq!(
            config.pointer("/proxy/allow_system_dns_fallback"),
            Some(&serde_json::Value::Bool(false))
        );
        assert_eq!(
            configured_vpn_dns_servers(&config).unwrap(),
            [Ipv4Addr::new(10, 90, 63, 2), Ipv4Addr::new(10, 90, 63, 3),]
        );
    }

    #[cfg(feature = "engine-lifecycle-fixture")]
    #[test]
    fn lifecycle_fixture_rejects_every_dns_exit() {
        let isolated = serde_json::json!({
            "proxy": {
                "allow_system_dns_fallback": false,
                "vpn_dns_servers": []
            }
        });
        assert!(validate_lifecycle_fixture_dns_isolation(&isolated, &[]).is_ok());

        let system_fallback = serde_json::json!({
            "proxy": {
                "allow_system_dns_fallback": true,
                "vpn_dns_servers": []
            }
        });
        assert!(validate_lifecycle_fixture_dns_isolation(&system_fallback, &[]).is_err());
        assert!(
            validate_lifecycle_fixture_dns_isolation(&isolated, &[Ipv4Addr::new(10, 90, 63, 2)],)
                .is_err()
        );
    }

    #[test]
    fn synthetic_control_reader_preserves_eof_and_typed_actions() {
        let wire = b"{\"type\":\"hello\",\"requestId\":1,\"versions\":[2]}\n{\"type\":\"request\",\"apiVersion\":2,\"requestId\":2,\"command\":{\"name\":\"require_capability\",\"capability\":\"transport.web_vpn\"}}\n{\"type\":\"request\",\"apiVersion\":2,\"requestId\":3,\"command\":{\"name\":\"shutdown\"}}\n{\"type\":\"cancel\",\"apiVersion\":2,\"requestId\":4,\"requestToCancel\":3}\n{\"type\":\"close\",\"apiVersion\":2,\"requestId\":5}\n";
        let (sender, mut receiver) = tokio::sync::mpsc::channel(MAX_ACTIVE_REQUESTS);
        control_reader_loop(wire.as_slice(), sender, None).unwrap();

        let hello = receiver.blocking_recv().unwrap();
        let ControlInput::V2(hello) = hello else {
            panic!("expected v2 hello");
        };
        assert!(matches!(
            hello.response,
            ec_compat::engine::control::ControlResponse::Hello { .. }
        ));
        let unsupported = receiver.blocking_recv().unwrap();
        let ControlInput::V2(unsupported) = unsupported else {
            panic!("expected v2 capability response");
        };
        assert!(matches!(
            unsupported.response,
            ec_compat::engine::control::ControlResponse::Error {
                error: ec_compat::engine::control::ControlProtocolError::UnsupportedCapability {
                    capability: ec_compat::engine::control::ControlCapability::TransportWebVpn,
                },
                ..
            }
        ));
        assert_eq!(unsupported.action, None);
        let shutdown = receiver.blocking_recv().unwrap();
        let ControlInput::V2(shutdown) = shutdown else {
            panic!("expected v2 shutdown");
        };
        assert_eq!(
            shutdown.action,
            Some(ControlAction::Shutdown { request_id: 3 })
        );
        let cancel = receiver.blocking_recv().unwrap();
        let ControlInput::V2(cancel) = cancel else {
            panic!("expected v2 cancel");
        };
        assert_eq!(
            cancel.action,
            Some(ControlAction::Cancel {
                request_id: 4,
                request_to_cancel: 3,
            })
        );
        let close = receiver.blocking_recv().unwrap();
        let ControlInput::V2(close) = close else {
            panic!("expected v2 close");
        };
        assert_eq!(close.action, Some(ControlAction::Close { request_id: 5 }));
        // Reader EOF/close drops only this bounded channel. There is no
        // synthesized Shutdown action.
        assert!(receiver.blocking_recv().is_none());
    }

    #[test]
    fn control_reader_multiplexes_v3_without_changing_v2_session_state() {
        let wire = b"{\"type\":\"auth_request\",\"apiVersion\":3,\"requestId\":7,\"generation\":9,\"transactionId\":\"04040404040404040404040404040404\",\"challengeEpoch\":1,\"command\":{\"name\":\"respond\",\"response\":\"private-fixture\"}}\n{\"type\":\"hello\",\"requestId\":8,\"versions\":[2]}\n{\"type\":\"close\",\"apiVersion\":2,\"requestId\":9}\n";
        let (sender, mut receiver) = tokio::sync::mpsc::channel(MAX_ACTIVE_REQUESTS);
        control_reader_loop(wire.as_slice(), sender, None).unwrap();

        let ControlInput::V3(request) = receiver.blocking_recv().unwrap() else {
            panic!("expected v3 auth request");
        };
        assert_eq!(request.request_id(), 7);
        assert!(!format!("{request:?}").contains("private-fixture"));
        let ControlInput::V2(hello) = receiver.blocking_recv().unwrap() else {
            panic!("expected v2 hello");
        };
        assert!(matches!(
            hello.response,
            ec_compat::engine::control::ControlResponse::Hello { .. }
        ));
        let ControlInput::V2(close) = receiver.blocking_recv().unwrap() else {
            panic!("expected v2 close");
        };
        assert_eq!(close.action, Some(ControlAction::Close { request_id: 9 }));
        assert!(receiver.blocking_recv().is_none());
    }

    #[test]
    fn queued_shutdown_is_cancellable_before_its_bounded_commit_window() {
        let now = tokio::time::Instant::now();
        let mut pending = PendingControlActions::default();
        assert!(!pending.apply(ControlAction::Shutdown { request_id: 41 }, now));
        assert_eq!(
            pending.next_shutdown_deadline(),
            Some(now + CONTROL_SHUTDOWN_CANCEL_WINDOW)
        );
        assert!(!pending.apply(
            ControlAction::Cancel {
                request_id: 42,
                request_to_cancel: 41,
            },
            now,
        ));
        assert_eq!(pending.next_shutdown_deadline(), None);
        assert!(pending.apply(ControlAction::Close { request_id: 43 }, now));
    }

    #[tokio::test]
    async fn connection_operation_close_cancels_and_collects_its_late_result() {
        let mut operation = BlockingOperation::spawn(|cancellation| {
            while !cancellation.is_cancelled() {
                std::thread::yield_now();
            }
            Ok::<_, ()>("late-transport-result")
        });
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        sender
            .send(ControlInput::V2(ControlExchange {
                response: ec_compat::engine::control::ControlResponse::Result {
                    api_version: 2,
                    request_id: 7,
                    status: ec_compat::engine::control::ControlStatus::Accepted,
                },
                action: Some(ControlAction::Close { request_id: 7 }),
            }))
            .await
            .unwrap();
        let mut receiver = Some(receiver);
        let mut pending_control_actions = PendingControlActions::default();
        let mut lifecycle = EngineLifecycle::new(Vec::new(), 9);
        let outcome = drive_blocking_connection_operation(
            &mut operation,
            tokio::time::Instant::now() + Duration::from_secs(1),
            &mut receiver,
            &mut pending_control_actions,
            &mut lifecycle,
        )
        .await;
        let ConnectionOperationOutcome::Cancelled { cause, completion } = outcome else {
            panic!("control close must cancel the connection-stage worker");
        };
        assert!(matches!(
            cause,
            ConnectionOperationCancellationCause::UserRequested
        ));
        assert_eq!(completion.unwrap(), Ok("late-transport-result"));
    }

    #[tokio::test]
    async fn accepted_shutdown_survives_an_operation_phase_transition() {
        let mut first = BlockingOperation::spawn(|_| Ok::<_, ()>("authenticated"));
        tokio::time::timeout(Duration::from_secs(1), async {
            while !first.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the synthetic first phase must finish before driving the control race");
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        sender
            .send(ControlInput::V2(ControlExchange {
                response: ec_compat::engine::control::ControlResponse::Result {
                    api_version: 2,
                    request_id: 8,
                    status: ec_compat::engine::control::ControlStatus::Accepted,
                },
                action: Some(ControlAction::Shutdown { request_id: 8 }),
            }))
            .await
            .unwrap();
        let mut receiver = Some(receiver);
        let mut pending_control_actions = PendingControlActions::default();
        let mut lifecycle = EngineLifecycle::new(Vec::new(), 11);
        let first_outcome = drive_blocking_connection_operation(
            &mut first,
            tokio::time::Instant::now() + Duration::from_secs(1),
            &mut receiver,
            &mut pending_control_actions,
            &mut lifecycle,
        )
        .await;
        assert!(matches!(
            first_outcome,
            ConnectionOperationOutcome::Completed(Ok("authenticated"))
        ));
        assert!(pending_control_actions.next_shutdown_deadline().is_some());

        let mut second = BlockingOperation::spawn(|cancellation| {
            while !cancellation.is_cancelled() {
                std::thread::yield_now();
            }
            Ok::<_, ()>("late-transport")
        });
        let second_outcome = drive_blocking_connection_operation(
            &mut second,
            tokio::time::Instant::now() + Duration::from_secs(1),
            &mut receiver,
            &mut pending_control_actions,
            &mut lifecycle,
        )
        .await;
        let ConnectionOperationOutcome::Cancelled { cause, completion } = second_outcome else {
            panic!("the accepted shutdown must commit in the next phase");
        };
        assert!(matches!(
            cause,
            ConnectionOperationCancellationCause::UserRequested
        ));
        assert_eq!(completion.unwrap(), Ok("late-transport"));
    }

    #[tokio::test]
    async fn connection_operation_deadline_cancels_and_collects_its_late_result() {
        let mut operation = BlockingOperation::spawn(|cancellation| {
            while !cancellation.is_cancelled() {
                std::thread::yield_now();
            }
            Ok::<_, ()>("deadline-result")
        });
        let mut receiver = None;
        let mut pending_control_actions = PendingControlActions::default();
        let mut lifecycle = EngineLifecycle::new(Vec::new(), 10);
        let outcome = drive_blocking_connection_operation(
            &mut operation,
            tokio::time::Instant::now() + Duration::from_millis(10),
            &mut receiver,
            &mut pending_control_actions,
            &mut lifecycle,
        )
        .await;
        let ConnectionOperationOutcome::Cancelled { cause, completion } = outcome else {
            panic!("deadline must cancel the connection-stage worker");
        };
        assert!(matches!(
            cause,
            ConnectionOperationCancellationCause::DeadlineExpired
        ));
        assert_eq!(completion.unwrap(), Ok("deadline-result"));
    }

    #[tokio::test]
    async fn connection_operation_owner_eof_cancels_and_collects_its_late_result() {
        let mut operation = BlockingOperation::spawn(|cancellation| {
            while !cancellation.is_cancelled() {
                std::thread::yield_now();
            }
            Ok::<_, ()>("owner-eof-result")
        });
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        drop(sender);
        let mut receiver = Some(receiver);
        let mut pending_control_actions = PendingControlActions::default();
        let mut lifecycle = EngineLifecycle::new(Vec::new(), 12);
        let outcome = drive_blocking_connection_operation(
            &mut operation,
            tokio::time::Instant::now() + Duration::from_secs(1),
            &mut receiver,
            &mut pending_control_actions,
            &mut lifecycle,
        )
        .await;
        let ConnectionOperationOutcome::Cancelled { cause, completion } = outcome else {
            panic!("owner EOF must cancel the connection-stage worker");
        };
        assert!(matches!(
            cause,
            ConnectionOperationCancellationCause::UserRequested
        ));
        assert_eq!(completion.unwrap(), Ok("owner-eof-result"));
        assert!(receiver.is_none());
    }

    #[tokio::test]
    async fn connection_operation_owner_eof_wins_over_ready_worker_completion() {
        let mut operation = BlockingOperation::spawn(|_| Ok::<_, ()>("completed"));
        // Make both branches ready before entering the coordinator.  A random
        // select winner used to let the result escape the pre-listener owner
        // boundary intermittently.
        tokio::time::sleep(Duration::from_millis(10)).await;
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        drop(sender);
        let mut receiver = Some(receiver);
        let mut pending_control_actions = PendingControlActions::default();
        let mut lifecycle = EngineLifecycle::new(Vec::new(), 13);
        let outcome = drive_blocking_connection_operation(
            &mut operation,
            tokio::time::Instant::now() + Duration::from_secs(1),
            &mut receiver,
            &mut pending_control_actions,
            &mut lifecycle,
        )
        .await;
        let ConnectionOperationOutcome::Cancelled { cause, completion } = outcome else {
            panic!("owner EOF must outrank a simultaneously ready worker result");
        };
        assert!(matches!(
            cause,
            ConnectionOperationCancellationCause::UserRequested
        ));
        assert_eq!(completion.unwrap(), Ok("completed"));
        assert!(receiver.is_none());
    }

    #[tokio::test]
    async fn non_cooperative_connection_operation_fails_closed_within_drain_deadline() {
        let (release, release_rx) = std::sync::mpsc::channel();
        let mut operation = BlockingOperation::spawn(move |_| {
            release_rx.recv().unwrap();
            Ok::<_, ()>("too-late")
        });
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        drop(sender);
        let mut receiver = Some(receiver);
        let mut pending_control_actions = PendingControlActions::default();
        let mut lifecycle = EngineLifecycle::new(Vec::new(), 14);
        let started = tokio::time::Instant::now();
        let outcome = drive_blocking_connection_operation(
            &mut operation,
            tokio::time::Instant::now() + Duration::from_secs(5),
            &mut receiver,
            &mut pending_control_actions,
            &mut lifecycle,
        )
        .await;
        let ConnectionOperationOutcome::Cancelled { cause, completion } = outcome else {
            panic!("owner EOF must cancel a non-cooperative operation");
        };
        assert!(matches!(
            cause,
            ConnectionOperationCancellationCause::UserRequested
        ));
        let error = completion.unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Lifecycle);
        assert!(started.elapsed() < Duration::from_secs(2));
        // Let the detached blocking task finish before this test runtime shuts
        // down; production exits the Engine process after emitting the typed
        // cleanup-unconfirmed terminal outcome.
        release.send(()).unwrap();
    }

    #[tokio::test]
    async fn serving_shutdown_precedence_is_deterministic() {
        fn controlled<T>(ready: bool, value: T) -> impl std::future::Future<Output = T> {
            let mut value = Some(value);
            std::future::poll_fn(move |_| {
                if ready {
                    std::task::Poll::Ready(
                        value.take().expect("ready future polled after completion"),
                    )
                } else {
                    std::task::Poll::Pending
                }
            })
        }

        async fn select(
            committed: bool,
            signal_ready: bool,
            service_ready: bool,
            unhealthy_ready: bool,
        ) -> ServingEvent {
            let signal = controlled(signal_ready, Ok(()));
            let service = controlled(service_ready, Error("service failed".into()));
            let unhealthy = controlled(unhealthy_ready, ());
            tokio::pin!(signal, service, unhealthy);
            let (sender, receiver) = tokio::sync::mpsc::channel(1);
            drop(sender);
            let mut control = Some(receiver);
            select_serving_event(
                committed.then(tokio::time::Instant::now),
                signal.as_mut(),
                service.as_mut(),
                unhealthy.as_mut(),
                &mut control,
            )
            .await
        }

        assert!(matches!(
            select(true, true, true, true).await,
            ServingEvent::ControlShutdownCommitted
        ));
        assert!(matches!(
            select(false, true, true, true).await,
            ServingEvent::Signal(Ok(()))
        ));
        assert!(matches!(
            select(false, false, true, true).await,
            ServingEvent::LocalServiceFailed(_)
        ));
        assert!(matches!(
            select(false, false, false, true).await,
            ServingEvent::NetworkDisconnected
        ));
        assert!(matches!(
            select(false, false, false, false).await,
            ServingEvent::Control(None)
        ));
    }

    #[tokio::test]
    async fn service_abort_is_drained_before_the_shutdown_sequence_continues() {
        use std::sync::atomic::{AtomicBool, Ordering};

        struct Dropped(std::sync::Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let dropped = std::sync::Arc::new(AtomicBool::new(false));
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let mut services = tokio::task::JoinSet::new();
        let task_drop = std::sync::Arc::clone(&dropped);
        services.spawn(async move {
            let _guard = Dropped(task_drop);
            let _ = started.send(());
            std::future::pending::<()>().await;
            Ok(())
        });
        started_rx.await.unwrap();
        abort_and_drain_services(&mut services).await;
        assert!(dropped.load(Ordering::SeqCst));
        assert!(services.is_empty());
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

    #[test]
    fn engine_lifecycle_accepts_only_the_reviewed_phase_order() {
        let mut lifecycle = EngineLifecycle::new(Vec::new(), 17);
        assert!(lifecycle.state(EngineState::Authenticating).is_err());
        lifecycle.state(EngineState::Connecting).unwrap();
        assert!(lifecycle.state(EngineState::Connected).is_err());
        lifecycle.state(EngineState::Authenticating).unwrap();
        lifecycle.state(EngineState::PreparingTunnel).unwrap();
        lifecycle.state(EngineState::Connected).unwrap();
        assert!(lifecycle.state(EngineState::Authenticating).is_err());
        lifecycle.begin_stopping().unwrap();
        lifecycle.begin_stopping().unwrap();
        lifecycle.finish(StopReason::UserRequested).unwrap();
        assert!(lifecycle.finish(StopReason::UserRequested).is_err());
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

    #[test]
    fn gateway_resolution_failure_is_retryable_only_before_authentication() {
        assert_eq!(
            gateway_connector_error_code(&Error::classified(
                ErrorKind::GatewayHttp,
                "synthetic DNS failure",
            )),
            EngineErrorCode::GatewayPreloginUnavailable,
        );
        assert_eq!(
            gateway_connector_error_code(&Error::classified(
                ErrorKind::Configuration,
                "synthetic policy failure",
            )),
            EngineErrorCode::ConfigurationInvalid,
        );
    }
}
