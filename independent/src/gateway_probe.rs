//! Credential-free, closed-contract probe for an unreviewed Gateway origin.
//!
//! This is not authentication and never proves L3, DNS or resource support.
//! It makes one fixed public EasyConnect discovery request through the same
//! public-address connector policy used by production, retains no Cookie jar,
//! and returns only a bounded sanitized classification.

use crate::gateway_connector::GatewayConnectorGeneration;
use crate::gateway_http::endpoint_url;
use crate::gateway_tls::{GatewayTlsTrust, client_config};
use crate::xml::{first_descendant_text, parse_xml};
use crate::{Error, ErrorKind, Result};
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, CONTENT_TYPE, USER_AGENT};
use reqwest::redirect::Policy;
use serde::Serialize;
use std::io::Read;
use std::time::Duration;
use zeroize::Zeroizing;

mod certificate;

pub fn observe_self_signed_gateway_certificate(
    connector: &GatewayConnectorGeneration,
    timeout: Duration,
) -> Result<String> {
    certificate::observe(connector, timeout)
}

pub const PUBLIC_GATEWAY_PROBE_PATH: &str = "/por/login_auth.csp?apiversion=1";
pub const PUBLIC_GATEWAY_PROBE_FAMILY: &str = "easyconnect-password-modern-l3-v1";
const PUBLIC_GATEWAY_PROBE_PROFILE_ID: &str = "custom-probe";
const PUBLIC_GATEWAY_PROBE_PROFILE_REVISION: u64 = 1;
const MAX_PUBLIC_PROBE_BODY_BYTES: usize = 64 * 1024;
const MIN_PUBLIC_PROBE_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_PUBLIC_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const PUBLIC_PROBE_USER_AGENT: &str = "CampusConnect-GatewayProbe/1";

fn probe_error(message: impl Into<String>) -> Error {
    Error::classified(ErrorKind::GatewayHttp, message)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicGatewayCompatibility {
    RecognizedCandidate,
    Unsupported,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PublicGatewayProbeResult {
    pub schema_version: u8,
    pub normalized_origin: String,
    pub https_identity_valid: bool,
    pub compatibility: PublicGatewayCompatibility,
    pub candidate_family: Option<String>,
    pub reported_version: Option<String>,
    pub http_status: u16,
}

fn sanitized_version(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        Some(value.to_owned())
    } else {
        Some("present_unknown".to_owned())
    }
}

fn classify_public_discovery(
    body: &[u8],
) -> (PublicGatewayCompatibility, Option<String>, Option<String>) {
    let Ok(document) = parse_xml(body, "public Gateway discovery") else {
        return (PublicGatewayCompatibility::Unknown, None, None);
    };
    let root = document.root_element();
    if root.tag_name().name() != "Auth" {
        return (PublicGatewayCompatibility::Unknown, None, None);
    }
    let error_code = first_descendant_text(root, "ErrorCode");
    let start_auth = first_descendant_text(root, "StartAuth");
    let has_known_auth_shape = matches!(error_code.trim(), "1" | "2")
        && matches!(start_auth.trim(), "0" | "1")
        && !first_descendant_text(root, "CSRF_RAND_CODE").is_empty();
    if !has_known_auth_shape {
        return (PublicGatewayCompatibility::Unknown, None, None);
    }
    (
        PublicGatewayCompatibility::RecognizedCandidate,
        Some(PUBLIC_GATEWAY_PROBE_FAMILY.to_owned()),
        sanitized_version(&first_descendant_text(root, "VPNVERSION")),
    )
}

fn supported_public_content_type(value: Option<&reqwest::header::HeaderValue>) -> bool {
    let Some(value) = value.and_then(|value| value.to_str().ok()) else {
        return false;
    };
    if value.len() > 128 {
        return false;
    }
    matches!(
        value
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "application/xml" | "text/xml"
    )
}

pub fn probe_public_gateway(
    origin: &str,
    generation: u64,
    timeout: Duration,
) -> Result<PublicGatewayProbeResult> {
    let connector = GatewayConnectorGeneration::resolve_system(
        PUBLIC_GATEWAY_PROBE_PROFILE_ID,
        PUBLIC_GATEWAY_PROBE_PROFILE_REVISION,
        generation,
        origin,
        false,
    )?;
    probe_public_gateway_with_connector(&connector, timeout)
}

pub fn probe_public_gateway_with_connector(
    connector: &GatewayConnectorGeneration,
    timeout: Duration,
) -> Result<PublicGatewayProbeResult> {
    probe_public_gateway_with_trust(connector, timeout, None)
}

pub fn probe_public_gateway_with_trust(
    connector: &GatewayConnectorGeneration,
    timeout: Duration,
    trust: Option<&GatewayTlsTrust>,
) -> Result<PublicGatewayProbeResult> {
    if !(MIN_PUBLIC_PROBE_TIMEOUT..=MAX_PUBLIC_PROBE_TIMEOUT).contains(&timeout) {
        return Err(probe_error(
            "public Gateway probe timeout is outside its bound",
        ));
    }
    if connector.reviewed_private_gateway_allowed() {
        return Err(probe_error(
            "public Gateway probe cannot use a private-address exception",
        ));
    }
    let builder = connector.apply_to_reqwest_builder(
        Client::builder()
            .redirect(Policy::none())
            .https_only(true)
            .cookie_store(false)
            .timeout(timeout),
    );
    let builder = if trust.is_some() {
        builder.use_preconfigured_tls(client_config(connector.origin(), trust)?)
    } else {
        builder
    };
    let client = builder
        .build()
        .map_err(|_| probe_error("public Gateway probe client could not be created"))?;
    let url = endpoint_url(connector.origin(), PUBLIC_GATEWAY_PROBE_PATH)?;
    let mut response = client
        .get(&url)
        .header(USER_AGENT, PUBLIC_PROBE_USER_AGENT)
        .header(ACCEPT, "application/xml,text/xml;q=0.9,*/*;q=0.1")
        .send()
        .map_err(|_| probe_error("public Gateway probe request failed"))?;
    if response.url().origin().ascii_serialization() != connector.origin() {
        return Err(probe_error("public Gateway probe escaped its origin"));
    }
    let status = response.status();
    let supported_content_type =
        supported_public_content_type(response.headers().get(CONTENT_TYPE));
    if status.is_redirection() {
        return Err(probe_error("public Gateway probe redirect was denied"));
    }
    let mut body = Zeroizing::new(Vec::new());
    response
        .by_ref()
        .take((MAX_PUBLIC_PROBE_BODY_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|_| probe_error("public Gateway probe response could not be read"))?;
    if body.len() > MAX_PUBLIC_PROBE_BODY_BYTES {
        return Err(probe_error(
            "public Gateway probe response exceeds its bound",
        ));
    }
    let (compatibility, candidate_family, reported_version) =
        if status.is_success() && supported_content_type {
            classify_public_discovery(&body)
        } else if status.is_client_error() {
            (PublicGatewayCompatibility::Unsupported, None, None)
        } else {
            (PublicGatewayCompatibility::Unknown, None, None)
        };
    Ok(PublicGatewayProbeResult {
        schema_version: 1,
        normalized_origin: connector.origin().to_owned(),
        https_identity_valid: true,
        compatibility,
        candidate_family,
        reported_version,
        http_status: status.as_u16(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DISCOVERY: &[u8] = include_bytes!("../tests/fixtures/login_auth.xml");

    #[test]
    fn known_discovery_is_only_a_sanitized_candidate() {
        let (compatibility, family, version) = classify_public_discovery(DISCOVERY);
        assert_eq!(
            compatibility,
            PublicGatewayCompatibility::RecognizedCandidate
        );
        assert_eq!(family.as_deref(), Some(PUBLIC_GATEWAY_PROBE_FAMILY));
        assert_eq!(version.as_deref(), Some("M7.6.8R2"));
        let encoded = serde_json::to_string(&(compatibility, family, version)).unwrap();
        for private in ["REDACTED", "TwfID", "CSRF_RAND_CODE", "RSA_ENCRYPT_KEY"] {
            assert!(!encoded.contains(private));
        }
    }

    #[test]
    fn unknown_or_malformed_discovery_never_invents_support() {
        for body in [
            b"<html>not a Gateway</html>".as_slice(),
            b"<Auth><ErrorCode>1</ErrorCode></Auth>".as_slice(),
            b"not xml".as_slice(),
        ] {
            assert_eq!(
                classify_public_discovery(body),
                (PublicGatewayCompatibility::Unknown, None, None),
            );
        }
    }

    #[test]
    fn reported_version_is_bounded_and_never_copies_markup() {
        assert_eq!(sanitized_version("M7.6.8R2").as_deref(), Some("M7.6.8R2"));
        assert_eq!(
            sanitized_version("<script>private</script>").as_deref(),
            Some("present_unknown")
        );
        assert_eq!(
            sanitized_version(&"x".repeat(33)).as_deref(),
            Some("present_unknown")
        );
    }

    #[test]
    fn only_bounded_xml_content_types_can_reach_the_classifier() {
        use reqwest::header::HeaderValue;
        for value in ["application/xml", "text/xml; charset=utf-8", "TEXT/XML"] {
            let header = HeaderValue::from_str(value).unwrap();
            assert!(supported_public_content_type(Some(&header)));
        }
        for value in ["text/html", "application/json", "text/xml-unsafe"] {
            let header = HeaderValue::from_str(value).unwrap();
            assert!(!supported_public_content_type(Some(&header)));
        }
        assert!(!supported_public_content_type(None));
        let oversized = HeaderValue::from_str(&format!("text/xml;{}", "x".repeat(129))).unwrap();
        assert!(!supported_public_content_type(Some(&oversized)));
    }

    #[test]
    fn private_exception_and_unbounded_deadlines_fail_before_network_io() {
        let connector = GatewayConnectorGeneration::from_resolved(
            "custom-probe",
            1,
            1,
            "https://gateway.example.test",
            true,
            vec!["10.0.0.1:443".parse().unwrap()],
        )
        .unwrap();
        assert!(probe_public_gateway_with_connector(&connector, Duration::from_secs(5)).is_err());
        let public = GatewayConnectorGeneration::from_resolved(
            "custom-probe",
            1,
            1,
            "https://gateway.example.test",
            false,
            vec!["8.8.8.8:443".parse().unwrap()],
        )
        .unwrap();
        assert!(probe_public_gateway_with_connector(&public, Duration::ZERO).is_err());
        assert!(probe_public_gateway_with_connector(&public, Duration::from_secs(16)).is_err());
    }
}
