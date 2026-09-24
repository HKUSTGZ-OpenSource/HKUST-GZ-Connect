use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

fn engine() -> Command {
    Command::new(env!("CARGO_BIN_EXE_ec-engine"))
}

fn events(output: &[u8]) -> Vec<Value> {
    std::str::from_utf8(output)
        .expect("engine stdout must be UTF-8 NDJSON")
        .lines()
        .map(|line| serde_json::from_str(line).expect("every stdout line must be one JSON event"))
        .collect()
}

fn slow_gateway_config(
    label: &str,
) -> (
    PathBuf,
    std::thread::JoinHandle<()>,
    std::sync::mpsc::Receiver<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let (accepted, accepted_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((_stream, _)) => {
                    let _ = accepted.send(());
                    std::thread::sleep(Duration::from_secs(2));
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("synthetic gateway accept failed: {error}"),
            }
        }
    });
    let path = std::env::temp_dir().join(format!(
        "hkustgz-auth-lifecycle-{label}-{}.json",
        std::process::id()
    ));
    let config = serde_json::json!({
        "base_url": format!("https://{address}"),
        "timeout_seconds": 1,
        "user_agent": "synthetic-auth-lifecycle",
        "endpoints": {
            "discovery": "/discovery",
            "password_config": "/password-config",
            "password_login": "/password-login",
            "logout": "/logout",
            "session_config": "/session-config"
        },
        "proxy": {
            "allow_system_dns_fallback": false,
            "vpn_dns_servers": []
        }
    });
    std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    (path, server, accepted_rx)
}

fn wait_bounded(mut child: Child) -> Output {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    panic!("engine did not terminate inside the authentication lifecycle bound");
}

#[test]
fn invalid_arguments_emit_only_bounded_machine_events_without_echoing_values() {
    let secret = "must-not-be-repeated";
    let output = engine()
        .args(["--password", secret])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains(secret));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));

    let events = events(&output.stdout);
    assert_eq!(events[0]["type"], "hello");
    assert!(
        events.iter().any(|event| {
            event["type"] == "fatal_error" && event["code"] == "INVALID_ARGUMENTS"
        })
    );
    assert_eq!(events.last().unwrap()["type"], "stopped");
    assert!(events.iter().all(|event| event.to_string().len() < 1024));
}

#[test]
fn generation_flows_through_lifecycle_when_credentials_are_absent() {
    let config = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("config")
        .join("hkustgz.json");
    let output = engine()
        .args([
            "--config",
            config.to_str().unwrap(),
            "--credentials-stdin",
            "--socks-bind",
            "127.0.0.1:6180",
            "--generation",
            "77",
        ])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());

    let events = events(&output.stdout);
    let states = events
        .iter()
        .filter(|event| event["type"] == "state_changed")
        .collect::<Vec<_>>();
    assert_eq!(
        states
            .iter()
            .map(|event| event["state"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["connecting", "authenticating", "stopping", "stopped"]
    );
    assert!(states.iter().all(|event| event["generation"] == 77));
    assert!(
        events.iter().any(|event| {
            event["type"] == "fatal_error" && event["code"] == "CREDENTIALS_INVALID"
        })
    );
    let stopped = events.last().unwrap();
    assert_eq!(stopped["type"], "stopped");
    assert_eq!(stopped["generation"], 77);

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(!stdout.contains("Client IP assigned"));
    assert!(!stdout.contains("ec-engine:"));
    assert!(String::from_utf8_lossy(&output.stderr).contains("ec-engine:"));
}

#[test]
fn configuration_failures_do_not_copy_local_paths_to_diagnostics_or_events() {
    let private_path = "/tmp/private-user-name/secret-profile.json";
    let output = engine()
        .args([
            "--config",
            private_path,
            "--credentials-stdin",
            "--socks-bind",
            "127.0.0.1:6180",
            "--generation",
            "8",
        ])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains(private_path));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(private_path));
    assert!(events(&output.stdout).iter().any(|event| {
        event["type"] == "fatal_error" && event["code"] == "CONFIGURATION_INVALID"
    }));
}

#[test]
fn opted_in_config_binding_requires_one_private_stdin_frame() {
    let config = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("config")
        .join("hkustgz.json");
    let output = engine()
        .args([
            "--config",
            config.to_str().unwrap(),
            "--profile-binding-v1-stdin",
            "--credentials-stdin",
            "--socks-bind",
            "127.0.0.1:6180",
        ])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(events(&output.stdout).iter().any(|event| {
        event["type"] == "fatal_error" && event["code"] == "CONFIGURATION_INVALID"
    }));
}

#[test]
fn engine_rechecks_config_digest_and_origin_before_reading_credentials() {
    let config = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("config")
        .join("hkustgz.json");
    let payload = std::fs::read(&config).unwrap();
    let digest = hex::encode(Sha256::digest(&payload));
    for (expected_digest, expected_origin) in [
        ("00".repeat(32), "https://remote.hkust-gz.edu.cn"),
        (digest.clone(), "https://other.example.edu"),
    ] {
        let private_credential = "must-not-appear-in-config-binding-errors";
        let binding = format!(
            "{{\"type\":\"engine_config_binding\",\"apiVersion\":1,\"configSha256\":\"{expected_digest}\",\"gatewayOrigin\":\"{expected_origin}\",\"profileId\":\"hkustgz\",\"profileRevision\":1,\"protocolFamily\":\"easyconnect-password-modern-l3-v1\"}}\n",
        );
        let mut child = engine()
            .args([
                "--config",
                config.to_str().unwrap(),
                "--profile-binding-v1-stdin",
                "--credentials-stdin",
                "--socks-bind",
                "127.0.0.1:6180",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(format!("{binding}student\n{private_credential}\n").as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success());
        assert!(events(&output.stdout).iter().any(|event| {
            event["type"] == "fatal_error" && event["code"] == "CONFIGURATION_INVALID"
        }));
        assert!(!String::from_utf8_lossy(&output.stdout).contains(private_credential));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(private_credential));
    }
}

#[test]
fn matching_config_binding_reaches_the_credential_boundary() {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("config")
        .join("hkustgz.json");
    let mut document: Value = serde_json::from_slice(&std::fs::read(source).unwrap()).unwrap();
    document["base_url"] = Value::String("https://8.8.8.8".into());
    let config = std::env::temp_dir().join(format!(
        "hkustgz-connector-credential-boundary-{}.json",
        std::process::id()
    ));
    let payload = serde_json::to_vec(&document).unwrap();
    std::fs::write(&config, &payload).unwrap();
    let digest = hex::encode(Sha256::digest(&payload));
    let binding = format!(
        "{{\"type\":\"engine_config_binding\",\"apiVersion\":1,\"configSha256\":\"{digest}\",\"gatewayOrigin\":\"https://8.8.8.8\",\"profileId\":\"hkustgz\",\"profileRevision\":1,\"protocolFamily\":\"easyconnect-password-modern-l3-v1\"}}\n",
    );
    let output = engine()
        .args([
            "--config",
            config.to_str().unwrap(),
            "--profile-binding-v1-stdin",
            "--credentials-stdin",
            "--socks-bind",
            "127.0.0.1:6180",
            "--generation",
            "9",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            child.stdin.take().unwrap().write_all(binding.as_bytes())?;
            child.wait_with_output()
        })
        .unwrap();
    std::fs::remove_file(config).unwrap();
    assert!(!output.status.success());
    assert!(
        events(&output.stdout).iter().any(|event| {
            event["type"] == "fatal_error" && event["code"] == "CREDENTIALS_INVALID"
        })
    );
}

#[test]
fn profile_bound_connector_policy_fails_before_reading_credentials() {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("config")
        .join("hkustgz.json");
    let mut document: Value = serde_json::from_slice(&std::fs::read(source).unwrap()).unwrap();
    document["base_url"] = Value::String("https://127.0.0.1".into());
    let config = std::env::temp_dir().join(format!(
        "hkustgz-forbidden-connector-{}.json",
        std::process::id()
    ));
    let payload = serde_json::to_vec(&document).unwrap();
    std::fs::write(&config, &payload).unwrap();
    let digest = hex::encode(Sha256::digest(&payload));
    let binding = format!(
        "{{\"type\":\"engine_config_binding\",\"apiVersion\":1,\"configSha256\":\"{digest}\",\"gatewayOrigin\":\"https://127.0.0.1\",\"profileId\":\"hkustgz\",\"profileRevision\":1,\"protocolFamily\":\"easyconnect-password-modern-l3-v1\"}}\n",
    );
    let private_credential = "must-not-reach-forbidden-connector";
    let mut child = engine()
        .args([
            "--config",
            config.to_str().unwrap(),
            "--profile-binding-v1-stdin",
            "--credentials-stdin",
            "--socks-bind",
            "127.0.0.1:6180",
            "--generation",
            "10",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(format!("{binding}student\n{private_credential}\n").as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    std::fs::remove_file(config).unwrap();
    assert!(events(&output.stdout).iter().any(|event| {
        event["type"] == "fatal_error" && event["code"] == "CONFIGURATION_INVALID"
    }));
    assert!(!String::from_utf8_lossy(&output.stdout).contains(private_credential));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(private_credential));
}

#[test]
fn typed_auth_configuration_failure_maps_to_configuration_code() {
    let config = std::env::temp_dir().join(format!(
        "hkustgz-empty-engine-config-{}.json",
        std::process::id()
    ));
    std::fs::write(&config, b"{}\n").unwrap();
    let mut child = engine()
        .args([
            "--config",
            config.to_str().unwrap(),
            "--credentials-stdin",
            "--socks-bind",
            "127.0.0.1:6180",
            "--generation",
            "9",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"synthetic-user\nsynthetic-password\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let _ = std::fs::remove_file(config);
    assert!(!output.status.success());
    let machine_events = events(&output.stdout);
    assert!(machine_events.iter().any(|event| {
        event["type"] == "fatal_error" && event["code"] == "CONFIGURATION_INVALID"
    }));
    assert!(
        !machine_events
            .iter()
            .any(|event| { event["type"] == "fatal_error" && event["code"] == "AUTH_FAILED" })
    );
}

#[test]
fn control_handshake_is_answered_before_authentication_finishes() {
    let config = std::env::temp_dir().join(format!(
        "hkustgz-preauth-control-config-{}.json",
        std::process::id()
    ));
    std::fs::write(&config, b"{}\n").unwrap();
    let mut child = engine()
        .args([
            "--config",
            config.to_str().unwrap(),
            "--credentials-stdin",
            "--control-api-v2-stdin",
            "--socks-bind",
            "127.0.0.1:6180",
            "--generation",
            "10",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(
            b"synthetic-user\nsynthetic-password\n{\"type\":\"hello\",\"requestId\":1,\"versions\":[2]}\n",
        )
        .unwrap();
    stdin.flush().unwrap();
    let output = child.wait_with_output().unwrap();
    drop(stdin);
    let _ = std::fs::remove_file(config);
    assert!(!output.status.success());
    let machine_events = events(&output.stdout);
    let control_hello = machine_events
        .iter()
        .position(|event| event["type"] == "control_hello")
        .expect("pre-auth control hello");
    let fatal = machine_events
        .iter()
        .position(|event| event["type"] == "fatal_error")
        .expect("configuration failure");
    assert!(control_hello < fatal);
    assert_eq!(machine_events[control_hello]["apiVersion"], 2);
    assert_eq!(machine_events[fatal]["code"], "CONFIGURATION_INVALID");
}

#[test]
fn shutdown_during_stalled_authentication_is_bounded_and_cleanup_unconfirmed() {
    let (config, server, accepted) = slow_gateway_config("shutdown");
    let mut child = engine()
        .args([
            "--config",
            config.to_str().unwrap(),
            "--credentials-stdin",
            "--control-api-v2-stdin",
            "--socks-bind",
            "127.0.0.1:6180",
            "--generation",
            "110",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(
            b"synthetic-user\nsynthetic-password\n{\"type\":\"hello\",\"requestId\":1,\"versions\":[2]}\n",
        )
        .unwrap();
    stdin.flush().unwrap();
    accepted
        .recv_timeout(Duration::from_secs(2))
        .expect("authentication request must be in flight before shutdown");
    stdin
        .write_all(
            b"{\"type\":\"request\",\"apiVersion\":2,\"requestId\":2,\"command\":{\"name\":\"shutdown\"}}\n",
        )
        .unwrap();
    stdin.flush().unwrap();
    let output = wait_bounded(child);
    drop(stdin);
    let _ = server.join();
    let _ = std::fs::remove_file(config);

    assert!(!output.status.success());
    let machine_events = events(&output.stdout);
    assert!(
        machine_events
            .iter()
            .any(|event| { event["type"] == "control_result" && event["requestId"] == 2 })
    );
    let fatal = machine_events
        .iter()
        .find(|event| event["type"] == "fatal_error")
        .expect("stalled cancellation must be an explicit terminal failure");
    assert_eq!(fatal["code"], "LOGOUT_FAILED");
    assert_eq!(fatal["secondaryCode"], "AUTH_CLEANUP_UNCONFIRMED");
    assert_eq!(machine_events.last().unwrap()["type"], "stopped");
    assert_eq!(machine_events.last().unwrap()["reason"], "logout_failed");
}

#[test]
fn private_pipe_eof_during_stalled_authentication_is_cleanup_unconfirmed() {
    let (config, server, accepted) = slow_gateway_config("eof");
    let mut child = engine()
        .args([
            "--config",
            config.to_str().unwrap(),
            "--credentials-stdin",
            "--control-api-v2-stdin",
            "--socks-bind",
            "127.0.0.1:6180",
            "--generation",
            "111",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(
            b"synthetic-user\nsynthetic-password\n{\"type\":\"hello\",\"requestId\":1,\"versions\":[2]}\n",
        )
        .unwrap();
    stdin.flush().unwrap();
    accepted
        .recv_timeout(Duration::from_secs(2))
        .expect("authentication request must be in flight before owner EOF");
    drop(stdin);
    let output = wait_bounded(child);
    let _ = server.join();
    let _ = std::fs::remove_file(config);

    assert!(!output.status.success());
    let machine_events = events(&output.stdout);
    let fatal = machine_events
        .iter()
        .find(|event| event["type"] == "fatal_error")
        .expect("stalled owner loss must be an explicit terminal failure");
    assert_eq!(fatal["code"], "LOGOUT_FAILED");
    assert_eq!(fatal["secondaryCode"], "AUTH_CLEANUP_UNCONFIRMED");
    assert_eq!(machine_events.last().unwrap()["type"], "stopped");
    assert_eq!(machine_events.last().unwrap()["reason"], "logout_failed");
}

#[test]
fn gateway_timeout_before_login_is_retryable_and_never_reported_as_rejected() {
    let (config, server, _accepted) = slow_gateway_config("timeout");
    let mut child = engine()
        .args([
            "--config",
            config.to_str().unwrap(),
            "--credentials-stdin",
            "--socks-bind",
            "127.0.0.1:6180",
            "--generation",
            "112",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"synthetic-user\nsynthetic-password\n")
        .unwrap();
    let output = wait_bounded(child);
    let _ = server.join();
    let _ = std::fs::remove_file(config);

    assert!(!output.status.success());
    let machine_events = events(&output.stdout);
    assert!(machine_events.iter().any(|event| {
        event["type"] == "fatal_error" && event["code"] == "GATEWAY_PRELOGIN_UNAVAILABLE"
    }));
    assert!(!machine_events.iter().any(|event| {
        event["type"] == "fatal_error"
            && matches!(
                event["code"].as_str(),
                Some("AUTH_REJECTED" | "AUTH_FAILED")
            )
    }));
}

#[test]
fn strict_proxy_credentials_are_bounded_stdin_only_and_never_echoed() {
    let config = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("config")
        .join("hkustgz.json");
    let private_proxy_password = format!("private-proxy-secret-{}", "x".repeat(255));
    let mut child = engine()
        .args([
            "--config",
            config.to_str().unwrap(),
            "--credentials-stdin",
            "--socks-auth-stdin",
            "--socks-bind",
            "127.0.0.1:6180",
            "--generation",
            "91",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let input = format!("gateway-user\ngateway-password\nlocal-user\n{private_proxy_password}\n");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stdout.contains(&private_proxy_password));
    assert!(!stderr.contains(&private_proxy_password));
    assert!(
        events(&output.stdout).iter().any(|event| {
            event["type"] == "fatal_error" && event["code"] == "CREDENTIALS_INVALID"
        })
    );
}

#[test]
fn optional_proxy_credentials_are_bounded_stdin_only_and_never_echoed() {
    let config = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("config")
        .join("hkustgz.json");
    let private_proxy_password = format!("private-optional-proxy-secret-{}", "x".repeat(255));
    let mut child = engine()
        .args([
            "--config",
            config.to_str().unwrap(),
            "--credentials-stdin",
            "--socks-auth-optional-stdin",
            "--socks-bind",
            "127.0.0.1:6180",
            "--generation",
            "92",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let input = format!("gateway-user\ngateway-password\nlocal-user\n{private_proxy_password}\n");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stdout.contains(&private_proxy_password));
    assert!(!stderr.contains(&private_proxy_password));
    assert!(
        events(&output.stdout).iter().any(|event| {
            event["type"] == "fatal_error" && event["code"] == "CREDENTIALS_INVALID"
        })
    );
}

#[test]
fn strict_and_optional_proxy_authentication_flags_are_mutually_exclusive() {
    let output = engine()
        .args([
            "--config",
            "profile.json",
            "--credentials-stdin",
            "--socks-auth-stdin",
            "--socks-auth-optional-stdin",
            "--socks-bind",
            "127.0.0.1:6180",
        ])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        events(&output.stdout).iter().any(|event| {
            event["type"] == "fatal_error" && event["code"] == "INVALID_ARGUMENTS"
        })
    );
}
