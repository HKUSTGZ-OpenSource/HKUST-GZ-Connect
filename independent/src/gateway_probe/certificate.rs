//! Credential-free first-use observation, never an authentication trust grant.
//! Only valid self-issued leaves rejected for UnknownIssuer are eligible.

use crate::gateway_connector::GatewayConnectorGeneration;
use crate::{Error, ErrorKind, Result};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::{WebPkiServerVerifier, verify_server_name};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::server::ParsedCertificate;
use rustls::{
    CertificateError, ClientConfig, ClientConnection, DigitallySignedStruct, RootCertStore,
    SignatureScheme,
};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use x509_parser::parse_x509_certificate;

fn failed() -> Error {
    Error::classified(
        ErrorKind::GatewayHttp,
        "Gateway certificate observation failed",
    )
}

#[derive(Debug)]
struct Observer {
    verifier: Arc<WebPkiServerVerifier>,
    fingerprint: Mutex<Option<String>>,
}

impl ServerCertVerifier for Observer {
    fn verify_server_cert(
        &self,
        leaf: &CertificateDer<'_>,
        chain: &[CertificateDer<'_>],
        name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        let rejected = self
            .verifier
            .verify_server_cert(leaf, chain, name, ocsp, now);
        if !matches!(
            rejected,
            Err(rustls::Error::InvalidCertificate(
                CertificateError::UnknownIssuer
            ))
        ) {
            return Err(rustls::Error::General(
                "Gateway is not eligible for first-use observation".into(),
            ));
        }
        let (remainder, cert) = parse_x509_certificate(leaf.as_ref())
            .map_err(|_| rustls::Error::General("Invalid Gateway certificate".into()))?;
        let seconds = i64::try_from(now.as_secs()).unwrap_or(i64::MAX);
        if !remainder.is_empty()
            || cert.subject() != cert.issuer()
            || seconds < cert.validity().not_before.timestamp()
            || seconds > cert.validity().not_after.timestamp()
        {
            return Err(rustls::Error::General(
                "Invalid first-use Gateway certificate".into(),
            ));
        }
        // UnknownIssuer short-circuits WebPKI before its name check. A leaf
        // that is otherwise self-issued and current must still cover this
        // exact DNS/IP name before a first-use observation can be offered.
        verify_server_name(&ParsedCertificate::try_from(leaf)?, name)?;
        *self
            .fingerprint
            .lock()
            .map_err(|_| rustls::Error::General("Observation unavailable".into()))? =
            Some(hex::encode(Sha256::digest(leaf.as_ref())));
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.verifier
            .verify_tls12_signature(message, cert, signature)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.verifier
            .verify_tls13_signature(message, cert, signature)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.verifier.supported_verify_schemes()
    }
}

/// Complete a signed TLS handshake, then close without application data. Never
/// retain raw certificate bytes, names, cookies or an authenticated session.
pub(super) fn observe(connector: &GatewayConnectorGeneration, timeout: Duration) -> Result<String> {
    if connector.reviewed_private_gateway_allowed()
        || timeout.is_zero()
        || timeout > Duration::from_secs(3)
    {
        return Err(failed());
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let roots = Arc::new(RootCertStore::from_iter(
        webpki_roots::TLS_SERVER_ROOTS.iter().cloned(),
    ));
    let observer = Arc::new(Observer {
        verifier: WebPkiServerVerifier::builder_with_provider(roots, provider.clone())
            .build()
            .map_err(|_| failed())?,
        fingerprint: Mutex::new(None),
    });
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| failed())?
        .dangerous()
        .with_custom_certificate_verifier(observer.clone())
        .with_no_client_auth();
    let name = ServerName::try_from(connector.host().trim_matches(['[', ']']).to_owned())
        .map_err(|_| failed())?;
    let mut connection = ClientConnection::new(Arc::new(config), name).map_err(|_| failed())?;
    let mut socket = connector.connect_tcp(timeout)?;
    socket
        .set_read_timeout(Some(timeout))
        .map_err(|_| failed())?;
    socket
        .set_write_timeout(Some(timeout))
        .map_err(|_| failed())?;
    while connection.is_handshaking() {
        connection.complete_io(&mut socket).map_err(|_| failed())?;
    }
    drop(socket);
    let fingerprint = observer
        .fingerprint
        .lock()
        .map_err(|_| failed())?
        .take()
        .ok_or_else(failed)?;
    Ok(fingerprint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};

    #[test]
    fn observation_is_only_for_valid_self_issued_untrusted_leaves() {
        let bytes = STANDARD
            .decode(include_str!("../../tests/fixtures/synthetic_gateway_certificate.b64").trim())
            .unwrap();
        let (_, cert) = parse_x509_certificate(&bytes).unwrap();
        let roots = Arc::new(RootCertStore::from_iter(
            webpki_roots::TLS_SERVER_ROOTS.iter().cloned(),
        ));
        let observer = Observer {
            verifier: WebPkiServerVerifier::builder_with_provider(
                roots,
                Arc::new(rustls::crypto::ring::default_provider()),
            )
            .build()
            .unwrap(),
            fingerprint: Mutex::new(None),
        };
        let leaf = CertificateDer::from(bytes.as_slice());
        let name = ServerName::try_from("synthetic-gateway.invalid").unwrap();
        let time = |seconds| UnixTime::since_unix_epoch(Duration::from_secs(seconds));
        assert!(
            observer
                .verify_server_cert(
                    &leaf,
                    &[],
                    &name,
                    &[],
                    time(cert.validity().not_before.timestamp() as u64 + 10)
                )
                .is_ok()
        );
        assert_eq!(
            observer.fingerprint.lock().unwrap().as_ref().unwrap().len(),
            64
        );
        observer.fingerprint.lock().unwrap().take();
        for wrong_name in ["other.example.test", "127.0.0.2"] {
            assert!(
                observer
                    .verify_server_cert(
                        &leaf,
                        &[],
                        &ServerName::try_from(wrong_name).unwrap(),
                        &[],
                        time(cert.validity().not_before.timestamp() as u64 + 10)
                    )
                    .is_err(),
                "unknown issuer must not hide a mismatched certificate name"
            );
            assert!(observer.fingerprint.lock().unwrap().is_none());
        }
        for seconds in [0, cert.validity().not_after.timestamp() as u64 + 1] {
            assert!(
                observer
                    .verify_server_cert(&leaf, &[], &name, &[], time(seconds))
                    .is_err()
            );
        }
        assert!(
            observer
                .verify_server_cert(
                    &CertificateDer::from(b"bad".as_slice()),
                    &[],
                    &name,
                    &[],
                    time(0)
                )
                .is_err()
        );
    }
}
