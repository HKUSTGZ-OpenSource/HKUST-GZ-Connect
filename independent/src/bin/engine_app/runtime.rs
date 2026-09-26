//! Binary-private post-Transport serving and ordered cleanup owner.
use super::engine_arguments::EngineArguments;
use super::engine_control::{
    ControlInput, PendingControlActions, receive_control, wait_for_control_shutdown,
};
use super::engine_events::EngineLifecycle;
use super::engine_failure::{
    EngineFailure, EngineResult, attach_cleanup_status, event_output_failure, failure,
};
use super::engine_operation::shutdown_signal;
#[cfg(feature = "engine-lifecycle-fixture")]
use ec_compat::ErrorKind;
use ec_compat::engine::dns::{VpnDnsResolver, VpnDnsSource, select_vpn_dns_servers};
use ec_compat::engine::event::{
    AddressFamily, DnsMode, EngineErrorCode, EngineEvent, EngineState, NetworkUnhealthyReason,
    StopReason,
};
use ec_compat::engine::netstack::VirtualNetstack;
use ec_compat::engine::proxy::{NameResolver, RejectDomainResolver, SystemDnsResolver};
use ec_compat::engine::session::AuthenticatedGatewaySession;
use ec_compat::engine::socks::SocksServer;
use ec_compat::engine::socks_auth::{ProxyAuthentication, ProxyAuthenticationMode};
use ec_compat::{Error, Result};
use std::io::Write;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

const NETSTACK_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

pub(super) enum GatewayCleanup {
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

fn dns_mode_for_source(source: VpnDnsSource) -> DnsMode {
    match source {
        VpnDnsSource::Gateway => DnsMode::Gateway,
        VpnDnsSource::Profile => DnsMode::VpnProfile,
        VpnDnsSource::GatewayAndProfile => DnsMode::GatewayProfile,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn serve_prepared_netstack<W: Write>(
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

async fn abort_and_drain_services(services: &mut tokio::task::JoinSet<Result<()>>) {
    services.abort_all();
    while services.join_next().await.is_some() {}
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

async fn wait_for_unhealthy(netstack: Arc<VirtualNetstack>) {
    while netstack.is_healthy() {
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vpn_dns_source_presentation_keeps_the_existing_modes() {
        assert_eq!(
            dns_mode_for_source(VpnDnsSource::Profile),
            DnsMode::VpnProfile
        );
        assert_eq!(
            dns_mode_for_source(VpnDnsSource::GatewayAndProfile),
            DnsMode::GatewayProfile
        );
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
}
