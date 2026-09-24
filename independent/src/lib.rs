pub mod adapter;
pub mod auth;
pub mod binary_watch;
pub mod config;
pub mod credentials;
pub mod engine;
pub mod gateway_auth;
pub mod gateway_connector;
pub mod gateway_http;
pub mod gateway_probe;
pub mod modern;
pub mod probe;
pub mod protocol_map;
pub mod resource_catalogue;
pub mod special_tls11;
pub mod tunnel;
pub mod watch;
pub mod xml;

use std::fmt::{Display, Formatter};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum ErrorKind {
    Unclassified,
    Credentials,
    Configuration,
    Authentication,
    AuthenticationRejected,
    AuthenticationIndeterminate,
    AuthenticationProtocolInvalid,
    AuthenticationLimitExceeded,
    AuthenticationExpired,
    AuthenticationStaleContext,
    DuplicateRequest,
    ResendUnavailable,
    UnsupportedCapability,
    CapabilityUnavailable,
    GatewayHttp,
    GatewayHttpIndeterminate,
    GatewayPreloginUnavailable,
    GatewayProtocolInvalid,
    Transport,
    DataPlane,
    DataPlaneTransient,
    Dns,
    LocalProxy,
    Lifecycle,
    Io,
    Serialization,
}

impl ErrorKind {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Unclassified => "unclassified",
            Self::Credentials => "credentials",
            Self::Configuration => "configuration",
            Self::Authentication => "authentication",
            Self::AuthenticationRejected => "authentication_rejected",
            Self::AuthenticationIndeterminate => "authentication_indeterminate",
            Self::AuthenticationProtocolInvalid => "authentication_protocol_invalid",
            Self::AuthenticationLimitExceeded => "authentication_limit_exceeded",
            Self::AuthenticationExpired => "authentication_expired",
            Self::AuthenticationStaleContext => "authentication_stale_context",
            Self::DuplicateRequest => "duplicate_request",
            Self::ResendUnavailable => "resend_unavailable",
            Self::UnsupportedCapability => "unsupported_capability",
            Self::CapabilityUnavailable => "capability_unavailable",
            Self::GatewayHttp => "gateway_http",
            Self::GatewayHttpIndeterminate => "gateway_http_indeterminate",
            Self::GatewayPreloginUnavailable => "gateway_prelogin_unavailable",
            Self::GatewayProtocolInvalid => "gateway_protocol_invalid",
            Self::Transport => "transport",
            Self::DataPlane => "data_plane",
            Self::DataPlaneTransient => "data_plane_transient",
            Self::Dns => "dns",
            Self::LocalProxy => "local_proxy",
            Self::Lifecycle => "lifecycle",
            Self::Io => "io",
            Self::Serialization => "serialization",
        }
    }

    pub const fn is_retryable(self) -> bool {
        matches!(self, Self::DataPlaneTransient)
    }
}

#[derive(Debug)]
pub struct Error {
    message: String,
    kind: ErrorKind,
    cleanup_unconfirmed: bool,
}

impl Error {
    pub fn new(message: String) -> Self {
        Self {
            message,
            kind: ErrorKind::Unclassified,
            cleanup_unconfirmed: false,
        }
    }

    pub fn classified(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind,
            cleanup_unconfirmed: false,
        }
    }

    pub const fn kind(&self) -> ErrorKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub const fn cleanup_unconfirmed(&self) -> bool {
        self.cleanup_unconfirmed
    }

    pub fn with_cleanup_unconfirmed(mut self) -> Self {
        self.cleanup_unconfirmed = true;
        self
    }

    pub fn with_kind_if_unclassified(mut self, kind: ErrorKind) -> Self {
        if self.kind == ErrorKind::Unclassified {
            self.kind = kind;
        }
        self
    }
}

// Preserve the long-standing `Error("message".into())` construction syntax
// while the implementation migrates incrementally to stable typed kinds.
#[allow(non_snake_case)]
pub fn Error(message: String) -> Error {
    Error::new(message)
}

impl Display for Error {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::classified(ErrorKind::Io, error.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::classified(ErrorKind::Serialization, error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_constructor_and_typed_kinds_coexist() {
        let legacy = Error("legacy message".into());
        assert_eq!(legacy.kind(), ErrorKind::Unclassified);
        assert_eq!(legacy.to_string(), "legacy message");

        let typed = Error::classified(ErrorKind::Authentication, "authentication failed");
        assert_eq!(typed.kind(), ErrorKind::Authentication);
        assert_eq!(typed.kind().code(), "authentication");
        assert!(!typed.kind().is_retryable());
        assert!(ErrorKind::DataPlaneTransient.is_retryable());

        let cleanup = Error::classified(
            ErrorKind::AuthenticationIndeterminate,
            "authentication result is indeterminate",
        )
        .with_cleanup_unconfirmed();
        assert_eq!(cleanup.kind(), ErrorKind::AuthenticationIndeterminate);
        assert!(cleanup.cleanup_unconfirmed());
    }

    #[test]
    fn standard_sources_receive_stable_kinds() {
        let io = Error::from(std::io::Error::other("fixture"));
        assert_eq!(io.kind(), ErrorKind::Io);
        let serialization =
            Error::from(serde_json::from_str::<serde_json::Value>("{").unwrap_err());
        assert_eq!(serialization.kind(), ErrorKind::Serialization);
    }
}
