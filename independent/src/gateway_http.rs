//! Origin-bound HTTPS session used by authentication and compatibility probes.
//!
//! The cookie jar and authenticated response bodies stay inside this Rust
//! object. The module has no dependency on Engine transport, local proxy, or
//! probe workflows, making it suitable for a future pending-auth transaction.

use crate::gateway_connector::GatewayConnectorGeneration;
use crate::gateway_tls::{GatewayTlsTrust, client_config};
use crate::xml::MAX_XML_BYTES;
use crate::{Error, ErrorKind, Result};
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, CONTENT_TYPE, SET_COOKIE, USER_AGENT};
use reqwest::redirect::Policy;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use url::Url;

pub const DEFAULT_TIMEOUT_SECONDS: u64 = 20;

fn configuration_error(message: impl Into<String>) -> Error {
    Error::classified(ErrorKind::Configuration, message)
}

fn gateway_error(message: impl Into<String>) -> Error {
    Error::classified(ErrorKind::GatewayHttp, message)
}

fn gateway_indeterminate(message: impl Into<String>) -> Error {
    Error::classified(ErrorKind::GatewayHttpIndeterminate, message)
}

fn gateway_protocol_error(message: impl Into<String>) -> Error {
    Error::classified(ErrorKind::GatewayProtocolInvalid, message)
}

pub fn endpoint_url(base_url: &str, path: &str) -> Result<String> {
    let base = Url::parse(base_url).map_err(|_| configuration_error("invalid base_url"))?;
    let candidate = Url::parse(path);
    if candidate.is_ok() || path.starts_with("//") {
        return Err(configuration_error(
            "endpoint paths must be relative to base_url",
        ));
    }
    let result = base
        .join(path.trim_start_matches('/'))
        .map_err(|_| configuration_error("invalid endpoint"))?;
    if result.scheme() != base.scheme()
        || result.host_str() != base.host_str()
        || result.port_or_known_default() != base.port_or_known_default()
    {
        return Err(configuration_error(
            "endpoint resolved outside base_url origin",
        ));
    }
    Ok(result.to_string())
}

#[derive(Default)]
struct CookieStats {
    count: usize,
    secure_count: usize,
}

pub struct GatewaySession {
    base_url: String,
    user_agent: String,
    client: Client,
    cookie_stats: Arc<Mutex<CookieStats>>,
    connector: Option<Arc<GatewayConnectorGeneration>>,
}

impl GatewaySession {
    pub fn new(base_url: String, user_agent: String, timeout: u64) -> Result<Self> {
        Self::build(base_url, user_agent, timeout, None, None)
    }

    pub fn new_with_connector(
        connector: Arc<GatewayConnectorGeneration>,
        user_agent: String,
        timeout: u64,
    ) -> Result<Self> {
        let base_url = connector.origin().to_owned();
        Self::build(base_url, user_agent, timeout, Some(connector), None)
    }

    pub fn new_with_trust(
        base_url: String,
        user_agent: String,
        timeout: u64,
        connector: Option<Arc<GatewayConnectorGeneration>>,
        trust: Option<&GatewayTlsTrust>,
    ) -> Result<Self> {
        Self::build(base_url, user_agent, timeout, connector, trust)
    }

    fn build(
        base_url: String,
        user_agent: String,
        timeout: u64,
        connector: Option<Arc<GatewayConnectorGeneration>>,
        trust: Option<&GatewayTlsTrust>,
    ) -> Result<Self> {
        let parsed = Url::parse(&base_url).map_err(|_| configuration_error("invalid base_url"))?;
        if parsed.scheme() != "https" {
            return Err(configuration_error("gateway base URL must use HTTPS"));
        }
        if user_agent.is_empty()
            || user_agent.len() > 128
            || !user_agent
                .bytes()
                .all(|byte| byte.is_ascii_graphic() || byte == b' ')
        {
            return Err(configuration_error(
                "gateway user agent has an invalid shape",
            ));
        }
        let builder = Client::builder();
        let builder = if let Some(connector) = connector.as_ref() {
            if connector.origin() != parsed.origin().ascii_serialization() {
                return Err(configuration_error(
                    "Gateway connector origin does not match the HTTPS session",
                ));
            }
            connector.apply_to_reqwest_builder(builder)
        } else {
            builder.no_proxy()
        };
        let builder = if trust.is_some() {
            builder.use_preconfigured_tls(client_config(&base_url, trust)?)
        } else {
            builder
        };
        let client = builder
            // Gateway control traffic must not inherit HTTP(S)_PROXY from the
            // parent shell or a desktop proxy application. The Modern data
            // plane opens its own direct sockets; proxying only discovery,
            // authentication, configuration, or logout would split one VPN
            // session across unrelated underlays and can recurse into this
            // application's not-yet-ready loopback listener.
            .timeout(Duration::from_secs(timeout))
            .redirect(Policy::none())
            .https_only(true)
            .cookie_store(true)
            .build()
            .map_err(|error| gateway_error(format!("cannot build HTTPS session: {error}")))?;
        Ok(Self {
            base_url,
            user_agent,
            client,
            cookie_stats: Arc::new(Mutex::new(CookieStats::default())),
            connector,
        })
    }

    pub fn connector(&self) -> Option<&GatewayConnectorGeneration> {
        self.connector.as_deref()
    }

    pub(crate) fn connector_handle(&self) -> Option<Arc<GatewayConnectorGeneration>> {
        self.connector.clone()
    }

    pub fn request(
        &self,
        path: &str,
        method: reqwest::Method,
        form: Option<&BTreeMap<String, String>>,
    ) -> Result<(Vec<u8>, BTreeMap<String, String>, u16)> {
        self.request_inner(path, method, form, None)
    }

    /// Sends one request with a deadline independent of the session default.
    /// Logout uses the same authenticated cookie jar with a shorter deadline.
    pub fn request_with_timeout(
        &self,
        path: &str,
        method: reqwest::Method,
        form: Option<&BTreeMap<String, String>>,
        timeout: Duration,
    ) -> Result<(Vec<u8>, BTreeMap<String, String>, u16)> {
        if timeout.is_zero() {
            return Err(configuration_error(
                "gateway request timeout must be nonzero",
            ));
        }
        self.request_inner(path, method, form, Some(timeout))
    }

    fn request_inner(
        &self,
        path: &str,
        method: reqwest::Method,
        form: Option<&BTreeMap<String, String>>,
        timeout: Option<Duration>,
    ) -> Result<(Vec<u8>, BTreeMap<String, String>, u16)> {
        let url = endpoint_url(&self.base_url, path)?;
        let mut request = self
            .client
            .request(method, &url)
            .header(USER_AGENT, &self.user_agent)
            .header(ACCEPT, "application/xml,text/xml,*/*;q=0.1");
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        if let Some(form) = form {
            request = request
                .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
                .form(form);
        }
        let mut response = request
            .send()
            .map_err(|_| gateway_indeterminate("gateway request outcome is indeterminate"))?;
        if response.status().is_redirection()
            || response.status().is_client_error()
            || response.status().is_server_error()
        {
            return Err(gateway_protocol_error(format!(
                "gateway returned HTTP {}",
                response.status().as_u16()
            )));
        }
        if response.url().scheme() != "https" {
            return Err(gateway_protocol_error(
                "gateway attempted a non-HTTPS response",
            ));
        }
        {
            let mut stats = self
                .cookie_stats
                .lock()
                .map_err(|_| gateway_error("cookie state unavailable"))?;
            for value in response.headers().get_all(SET_COOKIE) {
                if let Ok(value) = value.to_str() {
                    stats.count += 1;
                    if value
                        .split(';')
                        .any(|part| part.trim().eq_ignore_ascii_case("secure"))
                    {
                        stats.secure_count += 1;
                    }
                }
            }
        }
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter(|(name, _)| matches!(name.as_str(), "content-type" | "last-modified"))
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_owned(), value.trim().to_owned()))
            })
            .collect();
        let mut body = Vec::new();
        response
            .by_ref()
            .take((MAX_XML_BYTES + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|_| gateway_indeterminate("gateway response read outcome is indeterminate"))?;
        if body.len() > MAX_XML_BYTES {
            return Err(gateway_protocol_error(
                "gateway response exceeds the size limit",
            ));
        }
        Ok((body, headers, status))
    }

    pub fn cookie_summary(&self) -> Value {
        let stats = self.cookie_stats.lock().expect("cookie lock");
        json!({
            "count": stats.count,
            "secure_count": stats.secure_count,
            "session_cookie_present": stats.count > 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway_connector::GatewayConnectorGeneration;
    use std::net::SocketAddr;

    #[test]
    fn endpoint_is_origin_bound() {
        let error = endpoint_url(
            "https://vpn.example.edu",
            "https://attacker.invalid/payload",
        )
        .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Configuration);
        assert_eq!(
            endpoint_url("https://vpn.example.edu/base", "/metadata.xml").unwrap(),
            "https://vpn.example.edu/metadata.xml"
        );
    }

    #[test]
    fn gateway_session_requires_https_and_a_bounded_user_agent() {
        assert!(GatewaySession::new("http://vpn.example.edu".into(), "agent".into(), 20).is_err());
        assert!(GatewaySession::new("https://vpn.example.edu".into(), String::new(), 20).is_err());
        assert!(
            GatewaySession::new("https://vpn.example.edu".into(), "x".repeat(129), 20).is_err()
        );
    }

    #[test]
    fn gateway_session_disables_implicit_environment_proxies() {
        // reqwest's ProxyMatcher is intentionally opaque. Keep this as a
        // source-level architecture contract instead of mutating global proxy
        // environment variables in a parallel test process. The locked
        // reqwest API defines `no_proxy()` as clearing explicit matchers and
        // disabling automatic system/environment proxy discovery.
        let session_source = include_str!("gateway_http.rs");
        let builder = session_source
            .split_once("fn build(")
            .expect("GatewaySession builder")
            .1
            .split_once("pub fn connector(")
            .expect("GatewaySession connector accessor")
            .0;
        assert_eq!(builder.matches(".no_proxy()").count(), 1);
        assert!(builder.contains("connector.apply_to_reqwest_builder(builder)"));

        let connector_source = include_str!("gateway_connector.rs");
        let connector_builder = connector_source
            .split_once("pub fn apply_to_reqwest_builder")
            .expect("Gateway connector reqwest binding")
            .1
            .split_once("pub fn connect_tcp")
            .expect("Gateway connector TCP binding")
            .0;
        assert_eq!(connector_builder.matches(".no_proxy()").count(), 1);
        assert!(
            connector_builder.find(".no_proxy()").unwrap()
                < connector_builder.find(".resolve_to_addrs(").unwrap()
        );
    }

    #[test]
    fn connector_bound_session_preserves_exact_profile_origin_and_generation() {
        let connector = Arc::new(
            GatewayConnectorGeneration::from_resolved(
                "school-a",
                7,
                11,
                "https://vpn.example.edu",
                false,
                vec!["8.8.8.8:443".parse::<SocketAddr>().unwrap()],
            )
            .unwrap(),
        );
        let session =
            GatewaySession::new_with_connector(Arc::clone(&connector), "fixture-agent".into(), 20)
                .unwrap();
        let observed = session.connector().unwrap();
        assert_eq!(observed.profile_id(), "school-a");
        assert_eq!(observed.profile_revision(), 7);
        assert_eq!(observed.generation(), 11);
        assert_eq!(observed.origin(), "https://vpn.example.edu");
    }
}
