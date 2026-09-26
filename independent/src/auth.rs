use crate::xml::{first_descendant_text, parse_xml};
use crate::{Error, Result};
// rsa 0.9 intentionally uses its own rand_core 0.6 cryptographic interface.
use rsa::rand_core::OsRng;
use rsa::{BigUint, Pkcs1v15Encrypt, RsaPublicKey};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

const SAFE_AUTH_FIELDS: &[&str] = &[
    "ErrorCode",
    "NextService",
    "CurAuth",
    "IsFirstAuth",
    "RndImg",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    Authenticated,
    PasswordRequired,
    CaptchaRequired,
    SmsRequired,
    TokenRequired,
    CertificateRequired,
    HidRequired,
    SsoRequired,
    SecondaryUnknown,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct AuthSummary {
    pub error_code: i64,
    pub next_service: String,
    pub state: AuthState,
    pub cur_auth: i64,
    pub session_identifier_present: bool,
    pub schema_fields: Vec<String>,
}

pub fn safe_int(value: &str, default: i64) -> i64 {
    value.parse().unwrap_or(default)
}

pub fn safe_next_service(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return String::new();
    }
    if value.len() <= 64
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_/-".contains(character))
    {
        value.to_owned()
    } else {
        "present_unknown".to_owned()
    }
}

pub fn classify_auth(error_code: i64, next_service: &str) -> AuthState {
    if !matches!(error_code, 1 | 2) {
        return AuthState::Failed;
    }
    if next_service.is_empty() {
        return if error_code == 1 {
            AuthState::Authenticated
        } else {
            AuthState::SecondaryUnknown
        };
    }
    match next_service {
        "auth/psw" => AuthState::PasswordRequired,
        "auth/challenge" => AuthState::CaptchaRequired,
        "auth/sms" => AuthState::SmsRequired,
        "auth/token" => AuthState::TokenRequired,
        "auth/logincert" | "auth/_key" => AuthState::CertificateRequired,
        "auth/hid" => AuthState::HidRequired,
        "auth/domain" | "auth/wechat" | "auth/wechat_qrcode" => AuthState::SsoRequired,
        _ => AuthState::SecondaryUnknown,
    }
}

pub fn auth_summary(data: &[u8], source: &str) -> Result<AuthSummary> {
    let document = parse_xml(data, source)?;
    let root = document.root_element();
    let auth = if root.tag_name().name() == "Auth" {
        root
    } else {
        root.descendants()
            .find(|node| node.is_element() && node.tag_name().name() == "Auth")
            .ok_or_else(|| Error(format!("{source}: missing Auth element")))?
    };
    let error_code = safe_int(&first_descendant_text(auth, "ErrorCode"), 0);
    let next_service = safe_next_service(&first_descendant_text(auth, "NextService"));
    let fields = auth
        .descendants()
        .filter(|node| node.is_element())
        .map(|node| node.tag_name().name())
        .filter(|name| SAFE_AUTH_FIELDS.contains(name))
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    Ok(AuthSummary {
        error_code,
        next_service: next_service.clone(),
        state: classify_auth(error_code, &next_service),
        cur_auth: safe_int(&first_descendant_text(auth, "CurAuth"), 0),
        session_identifier_present: !first_descendant_text(auth, "TwfID").is_empty(),
        schema_fields: fields,
    })
}

pub fn pkcs1_v1_5_encode_with<F>(
    message: &[u8],
    size: usize,
    mut random_source: F,
) -> Result<Vec<u8>>
where
    F: FnMut(usize) -> Vec<u8>,
{
    if message.len() > size.saturating_sub(11) {
        return Err(Error(
            "password material is too long for the gateway RSA key".into(),
        ));
    }
    let padding_length = size - message.len() - 3;
    let mut padding = Vec::with_capacity(padding_length);
    while padding.len() < padding_length {
        for byte in random_source(padding_length - padding.len()) {
            if byte != 0 {
                padding.push(byte);
            }
            if padding.len() == padding_length {
                break;
            }
        }
    }
    let mut encoded = Vec::with_capacity(size);
    encoded.extend_from_slice(&[0, 2]);
    encoded.extend_from_slice(&padding);
    encoded.push(0);
    encoded.extend_from_slice(message);
    Ok(encoded)
}

pub fn rsa_encrypt_hex(message: &[u8], modulus_hex: &str, exponent: u64) -> Result<String> {
    let modulus_bytes = hex::decode(modulus_hex)
        .map_err(|_| Error("gateway returned an invalid RSA modulus".into()))?;
    let modulus = BigUint::from_bytes_be(&modulus_bytes);
    let exponent = BigUint::from(exponent);
    let key = RsaPublicKey::new(modulus, exponent)
        .map_err(|_| Error("gateway returned invalid RSA parameters".into()))?;
    let size = rsa::traits::PublicKeyParts::size(&key);
    if message.len() > size.saturating_sub(11) {
        return Err(Error(
            "password material is too long for the gateway RSA key".into(),
        ));
    }
    let encrypted = key
        .encrypt(&mut OsRng, Pkcs1v15Encrypt, message)
        .map_err(|error| Error(format!("RSA encryption failed: {error}")))?;
    Ok(hex::encode(encrypted))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_transitions_fail_closed() {
        assert_eq!(classify_auth(1, ""), AuthState::Authenticated);
        assert_eq!(classify_auth(2, "auth/sms"), AuthState::SmsRequired);
        assert_eq!(
            classify_auth(2, "auth/future-method"),
            AuthState::SecondaryUnknown
        );
        assert_eq!(classify_auth(1001, "auth/sms"), AuthState::Failed);
    }

    #[test]
    fn deterministic_encoding_has_correct_shape() {
        let encoded = pkcs1_v1_5_encode_with(b"message", 64, |size| vec![1; size]).unwrap();
        assert_eq!(encoded.len(), 64);
        assert!(encoded.starts_with(&[0, 2]));
        assert!(encoded.ends_with(b"\0message"));
        assert!(!encoded[2..56].contains(&0));
    }

    #[test]
    fn rsa_ciphertext_has_fixed_modulus_width() {
        let modulus = (BigUint::from(1_u8) << 512) - BigUint::from(569_u16);
        let encrypted =
            rsa_encrypt_hex(b"message", &hex::encode(modulus.to_bytes_be()), 3).unwrap();
        assert_eq!(encrypted.len(), 128);
    }

    #[test]
    fn summary_does_not_retain_secrets() {
        let data = br#"<Auth><ErrorCode>1</ErrorCode><NextService>auth/sms</NextService>
            <CurAuth>1</CurAuth><TwfID>secret-session</TwfID>
            <CSRF_RAND_CODE>secret-csrf</CSRF_RAND_CODE><Note>private-note</Note></Auth>"#;
        let summary = auth_summary(data, "test").unwrap();
        let serialized = serde_json::to_string(&summary).unwrap();
        assert_eq!(summary.state, AuthState::SmsRequired);
        assert!(summary.session_identifier_present);
        assert!(!serialized.contains("secret-session"));
        assert!(!serialized.contains("secret-csrf"));
        assert!(!serialized.contains("private-note"));
    }
}
