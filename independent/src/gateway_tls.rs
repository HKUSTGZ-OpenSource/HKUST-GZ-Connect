//! Explicit, origin-bound Gateway TLS trust. No automatic trust-on-first-use.
//!
//! Standard PKI remains the default. A separately confirmed leaf fingerprint
//! replaces PKI identity checks only for its exact HTTPS origin; validity and
//! TLS handshake signature checks still run. Browser trust is never consulted.

use crate::{Error, ErrorKind, Result};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use url::Url;
use x509_parser::parse_x509_certificate;

fn invalid() -> Error {
    Error::classified(
        ErrorKind::Configuration,
        "Gateway TLS trust binding is invalid",
    )
}

pub fn parse_leaf_sha256(value: &str) -> Result<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    let bytes = hex::decode(value).map_err(|_| invalid())?;
    bytes.try_into().map_err(|_| invalid())
}

fn root_origin(value: &str) -> Result<String> {
    let url = Url::parse(value).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(url.origin().ascii_serialization())
}

#[derive(Clone, Debug)]
pub struct GatewayTlsTrust {
    origin: String,
    leaf_sha256: [u8; 32],
}

impl GatewayTlsTrust {
    pub fn new(origin: &str, fingerprint: &str) -> Result<Self> {
        Ok(Self {
            origin: root_origin(origin)?,
            leaf_sha256: parse_leaf_sha256(fingerprint)?,
        })
    }

    /// Additive Engine config. A malformed present grant never falls back to PKI.
    pub fn from_config(config: &Value) -> Result<Option<Self>> {
        let Some(value) = config.get("gateway_tls") else {
            return Ok(None);
        };
        let object = value.as_object().ok_or_else(invalid)?;
        if object.len() != 2 {
            return Err(invalid());
        }
        let trust = Self::new(
            object
                .get("origin")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
            object
                .get("leaf_sha256")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
        )?;
        trust.check_origin(
            config
                .get("base_url")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
        )?;
        Ok(Some(trust))
    }

    pub(crate) fn check_origin(&self, origin: &str) -> Result<()> {
        if self.origin != root_origin(origin)? {
            return Err(invalid());
        }
        Ok(())
    }
}

pub(crate) fn client_config(origin: &str, trust: Option<&GatewayTlsTrust>) -> Result<ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|_| invalid())?;
    match trust {
        Some(trust) => {
            trust.check_origin(origin)?;
            let name = Url::parse(origin)
                .map_err(|_| invalid())?
                .host_str()
                .ok_or_else(invalid)?
                .trim_matches(['[', ']'])
                .to_owned();
            Ok(builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(LeafVerifier {
                    leaf_sha256: trust.leaf_sha256,
                    server_name: ServerName::try_from(name).map_err(|_| invalid())?,
                    provider,
                }))
                .with_no_client_auth())
        }
        None => Ok(builder
            .with_root_certificates(RootCertStore::from_iter(
                webpki_roots::TLS_SERVER_ROOTS.iter().cloned(),
            ))
            .with_no_client_auth()),
    }
}

#[derive(Debug)]
struct LeafVerifier {
    leaf_sha256: [u8; 32],
    server_name: ServerName<'static>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for LeafVerifier {
    fn verify_server_cert(
        &self,
        leaf: &CertificateDer<'_>,
        _chain: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        _ocsp: &[u8],
        now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        let fail = || rustls::Error::General("Gateway certificate trust mismatch".into());
        if server_name != &self.server_name
            || Sha256::digest(leaf.as_ref()).as_slice() != self.leaf_sha256
        {
            return Err(fail());
        }
        let (remainder, certificate) = parse_x509_certificate(leaf.as_ref()).map_err(|_| fail())?;
        let seconds = i64::try_from(now.as_secs()).map_err(|_| fail())?;
        if !remainder.is_empty()
            || seconds < certificate.validity().not_before.timestamp()
            || seconds > certificate.validity().not_after.timestamp()
        {
            return Err(fail());
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use serde_json::json;

    #[test]
    fn confirmed_self_signed_leaf_rejects_change_wrong_name_expiry_and_malformed_der() {
        // Generated synthetic public certificate; no private key is retained.
        let bytes = STANDARD
            .decode(include_str!("../tests/fixtures/synthetic_gateway_certificate.b64").trim())
            .unwrap();
        let (_, cert) = parse_x509_certificate(&bytes).unwrap();
        let now = UnixTime::since_unix_epoch(std::time::Duration::from_secs(
            cert.validity().not_before.timestamp() as u64 + 10,
        ));
        let name = ServerName::try_from("gateway.example.test").unwrap();
        let verifier = LeafVerifier {
            leaf_sha256: Sha256::digest(&bytes).into(),
            server_name: name.clone(),
            provider: Arc::new(rustls::crypto::ring::default_provider()),
        };
        let leaf = CertificateDer::from(bytes.as_slice());
        assert!(
            verifier
                .verify_server_cert(&leaf, &[], &name, &[], now)
                .is_ok()
        );
        let other = ServerName::try_from("other.example.test").unwrap();
        assert!(
            verifier
                .verify_server_cert(&leaf, &[], &other, &[], now)
                .is_err()
        );
        for time in [0, cert.validity().not_after.timestamp() as u64 + 1] {
            assert!(
                verifier
                    .verify_server_cert(
                        &leaf,
                        &[],
                        &name,
                        &[],
                        UnixTime::since_unix_epoch(std::time::Duration::from_secs(time))
                    )
                    .is_err()
            );
        }
        let mut changed = bytes.clone();
        changed[10] ^= 1;
        assert!(
            verifier
                .verify_server_cert(
                    &CertificateDer::from(changed.as_slice()),
                    &[],
                    &name,
                    &[],
                    now
                )
                .is_err()
        );
        let malformed = b"not a certificate";
        let invalid = LeafVerifier {
            leaf_sha256: Sha256::digest(malformed).into(),
            ..verifier
        };
        assert!(
            invalid
                .verify_server_cert(
                    &CertificateDer::from(malformed.as_slice()),
                    &[],
                    &name,
                    &[],
                    now
                )
                .is_err()
        );
    }

    #[test]
    fn grant_is_exact_origin_bound_and_never_a_global_insecure_switch() {
        let fingerprint = "ab".repeat(32);
        let trust =
            GatewayTlsTrust::new("https://gateway.example.test:4455", &fingerprint).unwrap();
        assert!(client_config("https://gateway.example.test:4455", Some(&trust)).is_ok());
        for other in [
            "http://gateway.example.test:4455",
            "https://other.example.test:4455",
            "https://gateway.example.test",
            "https://gateway.example.test:4455/path",
        ] {
            assert!(client_config(other, Some(&trust)).is_err());
        }
        assert!(
            GatewayTlsTrust::from_config(&json!({"base_url":"https://gateway.example.test"}))
                .unwrap()
                .is_none()
        );
        for value in [
            Value::Null,
            json!(true),
            json!({"origin":"https://gateway.example.test"}),
            json!({"origin":"https://other.example.test","leaf_sha256":fingerprint}),
            json!({"origin":"https://gateway.example.test","leaf_sha256":"bad"}),
        ] {
            assert!(
                GatewayTlsTrust::from_config(
                    &json!({"base_url":"https://gateway.example.test","gateway_tls":value})
                )
                .is_err()
            );
        }
    }

    #[test]
    fn leaf_parser_is_bounded_and_does_not_accept_ambiguous_shapes() {
        assert_eq!(parse_leaf_sha256(&"AB".repeat(32)).unwrap(), [0xab; 32]);
        for value in [
            "".to_owned(),
            "ab".repeat(31),
            "ab".repeat(33),
            "zz".repeat(32),
            format!(" {}", "ab".repeat(32)),
            "ab:".repeat(32),
        ] {
            assert!(parse_leaf_sha256(&value).is_err());
        }
    }
}
