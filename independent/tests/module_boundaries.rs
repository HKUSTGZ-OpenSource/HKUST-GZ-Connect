use std::fs;
use std::path::PathBuf;

fn source(path: &str) -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    fs::read_to_string(root.join(path)).expect("source file must be readable")
}

fn rust_sources(directory: PathBuf) -> Vec<PathBuf> {
    let mut sources = Vec::new();
    for entry in fs::read_dir(directory).expect("source directory") {
        let path = entry.expect("source entry").path();
        if path.is_dir() {
            sources.extend(rust_sources(path));
        } else if path.extension().and_then(|value| value.to_str()) == Some("rs") {
            sources.push(path);
        }
    }
    sources
}

#[test]
fn production_engine_never_imports_probe_workflows() {
    let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/engine");
    let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/bin/ec-engine.rs");
    let application = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/bin/engine_app");
    let mut sources = rust_sources(engine);
    sources.extend(rust_sources(application));
    sources.push(binary);
    for path in sources {
        let contents = fs::read_to_string(&path).expect("engine source");
        assert!(
            !contents.contains("crate::probe") && !contents.contains("ec_compat::probe"),
            "production engine depends on probe workflow: {}",
            path.display()
        );
    }
}

#[test]
fn argument_owner_is_binary_private_pure_and_keeps_the_reduced_composition_budget() {
    let main = source("src/bin/ec-engine.rs");
    let arguments = source("src/bin/engine_app/arguments.rs");
    assert!(
        main.lines().count() <= 2140,
        "ec-engine composition regrew after extraction"
    );
    assert!(
        arguments.lines().count() <= 600,
        "argument owner exceeds its module budget"
    );
    assert!(main.contains("mod engine_arguments;"));
    assert!(!main.contains("fn parse_arguments("));
    assert!(arguments.contains("pub(super) fn parse_arguments("));
    assert!(arguments.contains("pub(super) struct EngineArguments"));
    assert!(!source("src/lib.rs").contains("engine_arguments"));
    for forbidden in [
        "std::env",
        "std::fs",
        "TcpStream",
        "TcpListener",
        "reqwest",
        "read_engine_credentials",
    ] {
        assert!(
            !arguments.contains(forbidden),
            "argument owner acquired an effect: {forbidden}"
        );
    }
}

#[test]
fn production_engine_composes_one_closed_provider_set_instead_of_concrete_adapters() {
    let engine = source("src/bin/ec-engine.rs");
    assert!(engine.contains("ProductionProviderSet::from_config"));
    assert!(engine.contains("providers.authentication_provider()"));
    assert!(engine.contains("providers.transport_backend()"));
    assert!(!engine.contains("ModernL3TransportBackend::new"));
    assert!(
        !engine
            .contains("AuthenticatedGatewaySession::authenticate_with_provider_error_cancellable")
    );

    let composition = source("src/engine/provider_composition.rs").to_ascii_lowercase();
    assert!(composition.contains("easyconnect-password-modern-l3-v1"));
    for forbidden in ["libloading", "dlopen", "library::new", "loadlibrary"] {
        assert!(
            !composition.contains(forbidden),
            "composition contains {forbidden}"
        );
    }
}

#[test]
fn gateway_http_is_neutral_to_probe_transport_and_local_frontends() {
    let gateway = source("src/gateway_http.rs");
    for forbidden in [
        "crate::probe",
        "crate::modern",
        "crate::special_tls11",
        "crate::engine::socks",
        "crate::engine::dns",
        "crate::engine::data_plane",
        "crate::watch",
    ] {
        assert!(
            !gateway.contains(forbidden),
            "gateway HTTP imports {forbidden}"
        );
    }
}

#[test]
fn gateway_connector_is_profile_bound_but_credential_and_transport_neutral() {
    let connector = source("src/gateway_connector.rs");
    for forbidden in [
        "crate::credentials",
        "crate::gateway_auth",
        "crate::probe",
        "crate::modern",
        "crate::special_tls11",
        "crate::engine::socks",
        "crate::engine::dns",
        "std::env",
    ] {
        assert!(
            !connector.contains(forbidden),
            "Gateway connector imports {forbidden}"
        );
    }
    assert!(connector.contains(".no_proxy()"));
    assert!(connector.contains(".resolve_to_addrs("));
    assert!(connector.contains("peer_allowed"));
}

#[test]
fn production_gateway_http_is_bound_before_credentials_and_owned_by_one_session() {
    let engine = source("src/bin/ec-engine.rs");
    let run = engine
        .split_once("async fn run_engine")
        .expect("production run_engine")
        .1;
    let connector = run
        .find("GatewayConnectorGeneration::resolve_system")
        .expect("profile-bound Gateway connector");
    let credential = run
        .find("read_engine_credentials_prefix")
        .expect("private credential input");
    assert!(
        connector < credential,
        "Gateway origin and peer policy must fail before credential input"
    );

    let session = source("src/engine/session.rs");
    assert!(session.contains("GatewaySession::new_with_connector"));
    assert!(session.contains("http: GatewaySession"));
    assert!(session.contains(".request(&self.configuration_path"));
    assert!(session.contains(".request(&self.resource_list_path"));
    assert!(session.contains(".request_with_timeout(&self.logout_path"));
}

#[test]
fn production_modern_transport_consumes_the_authenticated_connector_generation() {
    let session = source("src/engine/session.rs");
    assert!(session.contains("session.http.connector_handle()"));
    assert!(session.contains("request_modern_token_with_connector"));

    let modern = source("src/modern.rs");
    assert!(modern.contains("connector: Option<Arc<GatewayConnectorGeneration>>"));
    assert!(modern.contains(".connect_tcp(timeout)"));

    let data_plane = source("src/engine/data_plane.rs");
    assert_eq!(
        data_plane.matches("acquisition.connector()").count(),
        3,
        "address, send and receive channels must consume the token connector"
    );
    assert!(data_plane.contains("SpecialTls11Stream::connect_with_connector"));

    let special_tls = source("src/special_tls11.rs");
    assert!(special_tls.contains("connect_gateway_tcp_to_connector(connector, peer, timeout)"));
    assert!(special_tls.contains("connector.host() != host"));
}

#[test]
fn public_gateway_probe_is_credential_free_fixed_and_non_promoting() {
    let probe = source("src/gateway_probe.rs");
    for forbidden in [
        "crate::credentials",
        "crate::gateway_auth",
        "crate::engine::session",
        "password_login",
        "cookie_store(true)",
        "Policy::limited",
        "Policy::custom",
    ] {
        assert!(
            !probe.contains(forbidden),
            "public probe contains {forbidden}"
        );
    }
    assert!(probe.contains("/por/login_auth.csp?apiversion=1"));
    assert!(probe.contains("Policy::none()"));
    assert!(probe.contains("cookie_store(false)"));
    assert!(probe.contains("MAX_PUBLIC_PROBE_BODY_BYTES"));
    assert!(probe.contains("PublicGatewayCompatibility::RecognizedCandidate"));
    assert!(!probe.contains("AuthenticatedGatewaySession"));
}

#[test]
fn credential_input_is_neutral_to_gateway_and_protocol_layers() {
    let credentials = source("src/credentials.rs");
    for forbidden in [
        "gateway_http",
        "crate::probe",
        "crate::engine",
        "crate::modern",
    ] {
        assert!(
            !credentials.contains(forbidden),
            "credential input imports {forbidden}"
        );
    }
}

#[test]
fn authenticated_gateway_artifacts_are_transport_neutral() {
    let authentication = source("src/gateway_auth.rs");
    for forbidden in [
        "crate::modern",
        "crate::special_tls11",
        "crate::engine::data_plane",
        "crate::engine::dns",
        "crate::engine::socks",
    ] {
        assert!(
            !authentication.contains(forbidden),
            "gateway auth artifact imports {forbidden}"
        );
    }
    let session = source("src/engine/session.rs");
    assert!(!session.contains("modern_session:"));
    assert!(session.contains("session_identifier: AuthenticatedSessionId"));
}

#[test]
fn auth_transaction_contract_contains_no_vendor_endpoint_or_fixed_otp_shape() {
    let transaction = source("src/engine/auth_transaction.rs").to_ascii_lowercase();
    for forbidden in [
        "/auth/sms",
        "/auth/token",
        "svpn_rand_code",
        "nextservice",
        "otp_length",
        "six_digit",
        "reqwest",
        "first_descendant_text",
    ] {
        assert!(
            !transaction.contains(forbidden),
            "generic transaction hard-codes {forbidden}"
        );
    }
    assert!(transaction.contains("authgatewayrequestbudget"));
    assert!(transaction.contains("authenticationlimitexceeded"));
}

#[test]
fn auth_control_v3_is_private_bounded_and_has_no_vendor_protocol_fields() {
    let control = source("src/engine/auth_control.rs").to_ascii_lowercase();
    for forbidden in [
        "tcp::bind",
        "tcplistener",
        "127.0.0.1",
        "/auth/",
        "svpn_",
        "nextservice",
        "twfid",
        "csrf_rand_code",
        "six_digit",
    ] {
        assert!(
            !control.contains(forbidden),
            "auth control hard-codes {forbidden}"
        );
    }
    assert!(control.contains("max_auth_control_frame_bytes"));
    assert!(control.contains("zeroizing"));
}
