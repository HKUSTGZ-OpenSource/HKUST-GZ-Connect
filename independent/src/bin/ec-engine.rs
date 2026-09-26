#[path = "engine_app/startup.rs"]
mod engine_startup;
use engine_startup::{
    authenticate_password_with_lifecycle, emit_initial_control_exchange,
    failure_after_gateway_cleanup, prepare_transport_with_lifecycle,
};

#[path = "engine_app/failure.rs"]
mod engine_failure;
#[path = "engine_app/runtime.rs"]
mod engine_runtime;
use engine_failure::{EngineResult, event_output_failure, failure, gateway_connector_error_code};
use engine_runtime::{GatewayCleanup, serve_prepared_netstack};

#[path = "engine_app/events.rs"]
mod engine_events;
#[path = "engine_app/operation.rs"]
mod engine_operation;
use engine_events::EngineLifecycle;

#[path = "engine_app/control.rs"]
mod engine_control;
use engine_control::{PendingControlActions, ProviderControlContext, start_control_reader};

#[path = "engine_app/arguments.rs"]
mod engine_arguments;
use engine_arguments::{
    EngineArguments, generation_hint, lifecycle_fixture_selected, parse_arguments,
};

use ec_compat::engine::config_binding::{load_engine_config, read_expected_config_binding};
use ec_compat::engine::dns::select_vpn_dns_servers;
use ec_compat::engine::event::{EngineErrorCode, EngineEvent, EngineState, StopReason};
use ec_compat::engine::ip_packet::stack_mtu;
use ec_compat::engine::netstack::VirtualNetstack;
use ec_compat::engine::provider_composition::{ProductionProviderFamily, ProductionProviderSet};
use ec_compat::engine::socks_auth::{
    EngineCredentials, read_engine_credentials, read_engine_credentials_prefix,
};
use ec_compat::gateway_connector::GatewayConnectorGeneration;
use ec_compat::{Error, Result};
use std::io::Write;
use std::net::Ipv4Addr;
use std::path::Path;
use std::sync::Arc;

#[cfg(feature = "engine-lifecycle-fixture")]
const ENGINE_LIFECYCLE_FIXTURE_MARKER: &str = "HKUSTGZ_TEST_ONLY_ENGINE_LIFECYCLE_V1";
#[cfg(feature = "engine-lifecycle-fixture")]
const ENGINE_LIFECYCLE_FIXTURE_USERNAME: &str = "synthetic-lifecycle-user";
#[cfg(feature = "engine-lifecycle-fixture")]
const ENGINE_LIFECYCLE_FIXTURE_PASSWORD: &str = "synthetic-lifecycle-password";
#[cfg(feature = "engine-lifecycle-fixture")]
const ENGINE_LIFECYCLE_FIXTURE_ADDRESS: Ipv4Addr = Ipv4Addr::new(10, 254, 0, 2);

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
            ec_compat::ErrorKind::Configuration,
            "lifecycle fixture requires DNS to remain disabled",
        ));
    }
    Ok(())
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
                    ec_compat::ErrorKind::Credentials,
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
}
