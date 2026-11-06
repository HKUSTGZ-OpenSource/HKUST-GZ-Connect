//! Real HTTPS/cookie isolation against a synthetic loopback server, not campus admission.
//! All credentials, cookies and session IDs below are invented. TLS keys exist only in memory.
use ec_compat::engine::auth_lifecycle::AuthenticationCancellation;
use ec_compat::engine::session::AuthenticatedGatewaySession;
use ec_compat::gateway_http::GatewaySession;
use ec_compat::gateway_tls::GatewayTlsTrust;
use reqwest::Method;
use rsa::traits::PublicKeyParts;
use rustls::pki_types::PrivatePkcs8KeyDer;
use rustls::{ServerConfig, ServerConnection, StreamOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

struct Step {
    path: &'static str,
    cookie: Option<&'static str>,
    set_cookie: Option<&'static str>,
    body: String,
    status: u16,
    cancel: Option<AuthenticationCancellation>,
}

impl Step {
    fn get(path: &'static str, cookie: Option<&'static str>, body: &str) -> Self {
        Self {
            path,
            cookie,
            set_cookie: None,
            body: body.into(),
            status: 200,
            cancel: None,
        }
    }
}

struct Gateway {
    origin: String,
    fingerprint: String,
    stop: Arc<AtomicBool>,
    server: Option<JoinHandle<usize>>,
}

impl Gateway {
    fn start(steps: Vec<Step>) -> Self {
        let identity = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
        let fingerprint = hex::encode(Sha256::digest(identity.cert.der()));
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = Arc::new(
            ServerConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(
                    vec![identity.cert.der().clone()],
                    PrivatePkcs8KeyDer::from(identity.signing_key.serialize_der()).into(),
                )
                .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("https://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = Arc::clone(&stop);
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut completed = 0;
            for step in steps {
                let socket = loop {
                    if stopping.load(Ordering::SeqCst) {
                        return completed;
                    }
                    assert!(
                        Instant::now() < deadline,
                        "synthetic HTTPS request deadline"
                    );
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2))
                        }
                        Err(error) => panic!("loopback accept failed: {error}"),
                    }
                };
                // Windows accepted sockets inherit the listener's nonblocking mode.
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let connection = ServerConnection::new(Arc::clone(&config)).unwrap();
                let mut stream = BufReader::new(StreamOwned::new(connection, socket));
                let mut line = String::new();
                stream.read_line(&mut line).unwrap();
                let expected_method = if step.path == "/login" { "POST" } else { "GET" };
                assert_eq!(
                    line.trim(),
                    format!("{expected_method} {} HTTP/1.1", step.path)
                );
                let mut headers = BTreeMap::new();
                let mut header_bytes = line.len();
                loop {
                    line.clear();
                    assert!(
                        stream.read_line(&mut line).unwrap() > 0,
                        "truncated headers"
                    );
                    header_bytes += line.len();
                    assert!(header_bytes < 8192, "fixture header bound");
                    if line == "\r\n" {
                        break;
                    }
                    let (name, value) = line.split_once(':').unwrap();
                    headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
                }
                assert_eq!(headers.get("cookie").map(String::as_str), step.cookie);
                let length = headers
                    .get("content-length")
                    .map(|value| value.parse().unwrap())
                    .unwrap_or(0);
                assert!(length < 4096, "fixture body bound");
                let mut body = vec![0; length];
                stream.read_exact(&mut body).unwrap();
                if expected_method == "POST" {
                    let fields: BTreeMap<_, _> =
                        url::form_urlencoded::parse(&body).into_owned().collect();
                    assert_eq!(
                        fields.get("svpn_name").map(String::as_str),
                        Some("synthetic-same-account")
                    );
                }
                if let Some(cancel) = &step.cancel {
                    cancel.cancel();
                }
                let cookie = step
                    .set_cookie
                    .map(|value| format!("Set-Cookie: {value}; Secure; HttpOnly; Path=/\r\n"))
                    .unwrap_or_default();
                write!(stream.get_mut(), "HTTP/1.1 {} Fixture\r\nContent-Length: {}\r\nContent-Type: application/xml\r\nConnection: close\r\n{}\r\n{}",
                    step.status, step.body.len(), cookie, step.body).unwrap();
                stream.get_mut().flush().unwrap();
                completed += 1;
            }
            completed
        });
        Self {
            origin,
            fingerprint,
            stop,
            server: Some(server),
        }
    }

    fn session(&self) -> GatewaySession {
        let trust = GatewayTlsTrust::new(&self.origin, &self.fingerprint).unwrap();
        GatewaySession::new_with_trust(
            self.origin.clone(),
            "synthetic-client".into(),
            3,
            None,
            Some(&trust),
        )
        .unwrap()
    }

    fn auth_config(&self) -> Value {
        json!({"base_url": self.origin, "timeout_seconds": 3,
            "gateway_tls": {"origin": self.origin, "leaf_sha256": self.fingerprint},
            "endpoints": {"discovery":"/discovery", "password_config":"/password-config",
                "password_login":"/login", "logout":"/logout"}})
    }

    fn finish(mut self, expected: usize) {
        assert_eq!(self.server.take().unwrap().join().unwrap(), expected);
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(server) = self.server.take() {
            let _ = server.join();
        }
    }
}

#[test]
fn same_origin_https_cookie_jars_survive_peer_logout_and_recreation() {
    let mut start_a = Step::get("/start", None, "ready");
    start_a.set_cookie = Some("fixture=a");
    let mut start_b = Step::get("/start", None, "ready");
    start_b.set_cookie = Some("fixture=b");
    let mut logout_a = Step::get("/logout", Some("fixture=a"), "bye");
    logout_a.set_cookie = Some("fixture=; Max-Age=0");
    let gateway = Gateway::start(vec![
        start_a,
        start_b,
        Step::get("/resource", Some("fixture=a"), "a"),
        Step::get("/resource", Some("fixture=b"), "b"),
        logout_a,
        Step::get("/resource", None, "cleared"),
        Step::get("/resource", Some("fixture=b"), "b"),
        Step::get("/resource", None, "fresh"),
        Step::get("/resource", Some("fixture=b"), "b"),
    ]);
    let a = gateway.session();
    let b = gateway.session();
    for session in [&a, &b] {
        session.request("/start", Method::GET, None).unwrap();
    }
    assert_eq!(a.request("/resource", Method::GET, None).unwrap().0, b"a");
    assert_eq!(b.request("/resource", Method::GET, None).unwrap().0, b"b");
    a.request_with_timeout("/logout", Method::GET, None, Duration::from_secs(3))
        .unwrap();
    assert_eq!(
        a.request("/resource", Method::GET, None).unwrap().0,
        b"cleared"
    );
    drop(a);
    assert_eq!(b.request("/resource", Method::GET, None).unwrap().0, b"b");
    let fresh = gateway.session();
    assert_eq!(
        fresh.request("/resource", Method::GET, None).unwrap().0,
        b"fresh"
    );
    assert_eq!(b.request("/resource", Method::GET, None).unwrap().0, b"b");
    gateway.finish(9);
}

fn login_steps(cookie: &'static str, twfid: &str, config: &str) -> Vec<Step> {
    let discovery = Step::get("/discovery", None, "<Auth/>");
    let password = Step::get("/password-config", None, config);
    let mut login = Step::get(
        "/login",
        None,
        &format!("<Auth><ErrorCode>1</ErrorCode><TwfID>{twfid}</TwfID></Auth>"),
    );
    login.set_cookie = Some(cookie);
    vec![discovery, password, login]
}

fn password_config() -> String {
    let key = rsa::RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 1024).unwrap();
    format!(
        "<Auth><RSA_ENCRYPT_KEY>{}</RSA_ENCRYPT_KEY><RSA_ENCRYPT_EXP>65537</RSA_ENCRYPT_EXP><CSRF_RAND_CODE>synthetic-csrf</CSRF_RAND_CODE><MID_ATK_CHECK>0</MID_ATK_CHECK></Auth>",
        key.n().to_str_radix(16)
    )
}

#[test]
fn authenticated_peer_logout_is_session_scoped_in_both_orders() {
    let password = password_config();
    for stop_a in [true, false] {
        let mut steps = login_steps("fixture=a", "synthetic-aaaaaa", &password);
        steps.extend(login_steps("fixture=b", "synthetic-bbbbbb", &password));
        let cookies = if stop_a {
            ["fixture=a", "fixture=b"]
        } else {
            ["fixture=b", "fixture=a"]
        };
        steps.extend(cookies.map(|cookie| Step::get("/logout", Some(cookie), "<ok/>")));
        let gateway = Gateway::start(steps);
        let config = gateway.auth_config();
        let a = AuthenticatedGatewaySession::authenticate(
            &config,
            "synthetic-same-account",
            "synthetic-password",
        )
        .unwrap();
        let b = AuthenticatedGatewaySession::authenticate(
            &config,
            "synthetic-same-account",
            "synthetic-password",
        )
        .unwrap();
        if stop_a {
            a.logout().unwrap();
            b.logout().unwrap();
        } else {
            b.logout().unwrap();
            a.logout().unwrap();
        }
        gateway.finish(8);
    }
}

#[test]
fn cancelled_or_failed_login_cleans_only_its_own_https_session() {
    let password = password_config();
    for cancel_login in [true, false] {
        let cancellation = AuthenticationCancellation::default();
        let mut steps = login_steps("fixture=b", "synthetic-bbbbbb", &password);
        let mut attempt = login_steps("fixture=a", "synthetic-aaaaaa", &password);
        if cancel_login {
            attempt[2].cancel = Some(cancellation.clone());
        } else {
            attempt[2].status = 500;
        }
        steps.extend(attempt);
        steps.extend([
            Step::get("/logout", Some("fixture=a"), "<ok/>"),
            Step::get("/logout", Some("fixture=b"), "<ok/>"),
        ]);
        let gateway = Gateway::start(steps);
        let config = gateway.auth_config();
        let b = AuthenticatedGatewaySession::authenticate(
            &config,
            "synthetic-same-account",
            "synthetic-password",
        )
        .unwrap();
        let failure = AuthenticatedGatewaySession::authenticate_with_provider_error_cancellable(
            &config,
            "synthetic-same-account",
            "synthetic-password",
            &cancellation,
        )
        .err()
        .expect("synthetic attempt must fail");
        let failure = ec_compat::Error::from(failure);
        assert_eq!(
            failure.kind(),
            if cancel_login {
                ec_compat::ErrorKind::Lifecycle
            } else {
                ec_compat::ErrorKind::AuthenticationProtocolInvalid
            }
        );
        assert!(!failure.cleanup_unconfirmed());
        b.logout().unwrap();
        gateway.finish(8);
    }
}
