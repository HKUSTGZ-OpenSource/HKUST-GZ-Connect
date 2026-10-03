//! Credential-free gateway locator resolution. Never used during authentication.
//! HTTP is allowed only to discover an HTTPS root through bounded redirects.

use crate::gateway_connector::GatewayConnectorGeneration;
use crate::{Error, ErrorKind, Result};
use reqwest::blocking::Client;
use reqwest::header::LOCATION;
use reqwest::redirect::Policy;
use std::time::{Duration, Instant};
use url::Url;

const MAX_HOPS: usize = 3;

fn invalid() -> Error {
    Error::classified(
        ErrorKind::Configuration,
        "Gateway locator is invalid or unsafe",
    )
}

fn locator(value: &str) -> Result<Url> {
    if value.is_empty() || value.len() > 2048 || value.chars().any(|c| c.is_control() || c == '\\')
    {
        return Err(invalid());
    }
    let value = value.trim();
    let candidate = if value.contains("://") {
        value.to_owned()
    } else {
        format!("https://{value}")
    };
    let url = Url::parse(&candidate).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() == Some(0)
    {
        return Err(invalid());
    }
    Ok(url)
}

fn is_gateway_root(url: &Url) -> bool {
    url.scheme() == "https" && url.path() == "/"
}

fn public_connector(url: &Url, generation: u64) -> Result<GatewayConnectorGeneration> {
    let mut root = url.clone();
    let port = url.port_or_known_default().ok_or_else(invalid)?;
    root.set_scheme("https").map_err(|_| invalid())?;
    root.set_port(Some(port)).map_err(|_| invalid())?;
    root.set_path("/");
    GatewayConnectorGeneration::resolve_system(
        "gateway-locator",
        1,
        generation,
        root.as_str(),
        false,
    )
}

/// Bounded GETs, no cookies, no auth headers, no response-body retention.
/// Each hop resolves once through the existing public-address connector policy.
/// HTTPS locator hops retain standard PKI; a final Gateway pin cannot authorize
/// a different locator. The returned origin is still only an untrusted candidate.
pub fn resolve_gateway_locator(value: &str, timeout: Duration) -> Result<String> {
    if !(Duration::from_secs(1)..=Duration::from_secs(15)).contains(&timeout) {
        return Err(invalid());
    }
    let deadline = Instant::now() + timeout;
    let mut url = locator(value)?;
    let mut visited = Vec::new();
    for hop in 0..=MAX_HOPS {
        if visited.contains(&url) {
            return Err(invalid());
        }
        visited.push(url.clone());
        let connector = public_connector(&url, hop as u64 + 1)?;
        if is_gateway_root(&url) {
            return Ok(connector.origin().to_owned());
        }
        if hop == MAX_HOPS {
            return Err(invalid());
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(invalid)?;
        let client = connector
            .apply_to_reqwest_builder(
                Client::builder()
                    .redirect(Policy::none())
                    .cookie_store(false)
                    .timeout(remaining),
            )
            .build()
            .map_err(|_| invalid())?;
        let response = client
            .get(url.clone())
            .header("Accept", "text/html,application/xml;q=0.9")
            .header("User-Agent", "CampusConnect-GatewayLocator/1")
            .send()
            .map_err(|_| invalid())?;
        if !response.status().is_redirection() {
            return Err(invalid());
        }
        let target = response
            .headers()
            .get(LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(invalid)?;
        if target.len() > 2048 {
            return Err(invalid());
        }
        let next = url.join(target).map_err(|_| invalid())?;
        let next = locator(next.as_str())?;
        // Never follow a downgrade, or another plaintext hop after entry.
        if next.scheme() != "https" {
            return Err(invalid());
        }
        url = next;
    }
    Err(invalid())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locator_forms_do_not_relax_authentication_origin_contract() {
        assert_eq!(
            locator("vpn.example.test:4455").unwrap().as_str(),
            "https://vpn.example.test:4455/"
        );
        assert!(is_gateway_root(
            &locator("https://vpn.example.test").unwrap()
        ));
        assert!(!is_gateway_root(
            &locator("http://entry.example.test/ssl/start.php").unwrap()
        ));
        for value in [
            "",
            "ftp://vpn.example.test",
            "https://u:p@vpn.example.test",
            "https://vpn.example.test/?secret=1",
            "https://vpn.example.test/#fragment",
            "https://vpn.example.test:0",
            "https://vpn.example.test\\path",
        ] {
            assert!(locator(value).is_err(), "accepted unsafe input");
        }
    }

    #[test]
    fn root_and_redirect_candidates_use_public_only_peer_policy() {
        for value in [
            "https://127.0.0.1",
            "http://169.254.169.254/metadata",
            "https://192.168.1.1",
            "https://[::1]",
            "https://[::ffff:127.0.0.1]",
            "https://100.64.0.1",
        ] {
            assert!(resolve_gateway_locator(value, Duration::from_secs(1)).is_err());
        }
    }
}
