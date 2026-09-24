//! Versioned machine-readable events emitted by the production engine.
//!
//! Stdout is an API boundary: only one bounded JSON object per line belongs on
//! it. Human diagnostics stay on stderr. Keeping the schema in this module
//! prevents UI wording changes from becoming accidental protocol changes.

use crate::engine::auth_control::{AuthControlEvent, AuthControlResponse};
use crate::engine::control::{ControlResponse, encode_control_response};
use crate::{Error, Result};
use serde::{Serialize, Serializer};
use std::io::Write;
use std::net::Ipv4Addr;

pub const ENGINE_API_VERSION: u8 = 1;
pub const MAX_ENGINE_EVENT_BYTES: usize = 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineCapability {
    Password,
    L3,
    Udp,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineState {
    Connecting,
    Authenticating,
    PreparingTunnel,
    Connected,
    Stopping,
    Stopped,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AddressFamily {
    Ipv4,
    Ipv6,
}

impl Serialize for AddressFamily {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u8(match self {
            Self::Ipv4 => 4,
            Self::Ipv6 => 6,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DnsMode {
    Gateway,
    VpnProfile,
    GatewayProfile,
    SystemFallback,
    Disabled,
}

impl DnsMode {
    pub fn diagnostic_name(self) -> &'static str {
        match self {
            Self::Gateway => "gateway",
            Self::VpnProfile => "VPN profile",
            Self::GatewayProfile => "gateway + VPN profile",
            Self::SystemFallback => "system fallback",
            Self::Disabled => "disabled",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkUnhealthyReason {
    DataPlaneDisconnected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EngineErrorCode {
    InvalidArguments,
    ConfigurationInvalid,
    CredentialsInvalid,
    AuthFailed,
    AuthRejected,
    AuthIndeterminate,
    GatewayPreloginUnavailable,
    AuthProtocolInvalid,
    AuthCleanupUnconfirmed,
    AuthExpired,
    AuthLimitExceeded,
    UnsupportedAuthentication,
    DataPlaneSetupTransient,
    DataPlaneSetupFailed,
    DataPlaneShutdownFailed,
    LocalListenerFailed,
    NetworkDisconnected,
    LogoutFailed,
    ShutdownSignalFailed,
    EventOutputFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    UserRequested,
    StartupFailed,
    LocalServiceFailed,
    NetworkUnhealthy,
    LogoutFailed,
    ShutdownFailed,
    EventOutputFailed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    Hello {
        #[serde(rename = "apiVersion")]
        api_version: u8,
        capabilities: [EngineCapability; 3],
    },
    StateChanged {
        state: EngineState,
        generation: u64,
    },
    ClientIpAssigned {
        family: AddressFamily,
        address: Ipv4Addr,
    },
    DnsMode {
        mode: DnsMode,
    },
    ListenerReady {
        port: u16,
    },
    NetworkUnhealthy {
        reason: NetworkUnhealthyReason,
    },
    FatalError {
        code: EngineErrorCode,
        #[serde(rename = "secondaryCode", skip_serializing_if = "Option::is_none")]
        secondary_code: Option<EngineErrorCode>,
    },
    Stopped {
        reason: StopReason,
        generation: u64,
    },
}

impl EngineEvent {
    pub fn hello() -> Self {
        Self::Hello {
            api_version: ENGINE_API_VERSION,
            capabilities: [
                EngineCapability::Password,
                EngineCapability::L3,
                EngineCapability::Udp,
            ],
        }
    }
}

pub struct EngineEventEmitter<W> {
    writer: W,
}

impl<W: Write> EngineEventEmitter<W> {
    pub fn new(writer: W) -> Self {
        Self { writer }
    }

    pub fn emit(&mut self, event: &EngineEvent) -> Result<()> {
        let encoded = encode_bounded_json_line(event)?;
        self.write_frame(&encoded, "engine event")
    }

    /// Write a v2 control response on the shared machine-output stream.
    ///
    /// Event API v1 remains unchanged: older consumers ignore these distinct
    /// response shapes, while v2 supervisors correlate them by request ID.
    pub fn emit_control(&mut self, response: &ControlResponse) -> Result<()> {
        let encoded = encode_control_response(response)?;
        self.write_frame(&encoded, "engine control response")
    }

    pub fn emit_auth_control(&mut self, response: &AuthControlResponse) -> Result<()> {
        let encoded = encode_bounded_json_line(response)?;
        self.write_frame(&encoded, "auth control response")
    }

    pub fn emit_auth_event(&mut self, event: &AuthControlEvent) -> Result<()> {
        let encoded = encode_bounded_json_line(event)?;
        self.write_frame(&encoded, "auth control event")
    }

    fn write_frame(&mut self, encoded: &[u8], kind: &str) -> Result<()> {
        self.writer
            .write_all(encoded)
            .map_err(|error| Error(format!("cannot write {kind}: {error}")))?;
        self.writer
            .flush()
            .map_err(|error| Error(format!("cannot flush {kind}: {error}")))
    }

    #[cfg(test)]
    fn into_inner(self) -> W {
        self.writer
    }
}

fn encode_bounded_json_line<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let mut encoded = serde_json::to_vec(value)
        .map_err(|error| Error(format!("cannot serialize engine event: {error}")))?;
    if encoded.len() + 1 > MAX_ENGINE_EVENT_BYTES {
        return Err(Error("engine event exceeds the wire limit".into()));
    }
    encoded.push(b'\n');
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn api_v1_schema_is_stable() {
        let cases = [
            (
                EngineEvent::hello(),
                json!({
                    "type": "hello",
                    "apiVersion": 1,
                    "capabilities": ["password", "l3", "udp"],
                }),
            ),
            (
                EngineEvent::StateChanged {
                    state: EngineState::Connecting,
                    generation: 42,
                },
                json!({"type": "state_changed", "state": "connecting", "generation": 42}),
            ),
            (
                EngineEvent::StateChanged {
                    state: EngineState::PreparingTunnel,
                    generation: 42,
                },
                json!({
                    "type": "state_changed",
                    "state": "preparing_tunnel",
                    "generation": 42,
                }),
            ),
            (
                EngineEvent::ClientIpAssigned {
                    family: AddressFamily::Ipv4,
                    address: Ipv4Addr::new(10, 20, 30, 40),
                },
                json!({"type": "client_ip_assigned", "family": 4, "address": "10.20.30.40"}),
            ),
            (
                EngineEvent::DnsMode {
                    mode: DnsMode::SystemFallback,
                },
                json!({"type": "dns_mode", "mode": "system_fallback"}),
            ),
            (
                EngineEvent::DnsMode {
                    mode: DnsMode::VpnProfile,
                },
                json!({"type": "dns_mode", "mode": "vpn_profile"}),
            ),
            (
                EngineEvent::DnsMode {
                    mode: DnsMode::GatewayProfile,
                },
                json!({"type": "dns_mode", "mode": "gateway_profile"}),
            ),
            (
                EngineEvent::ListenerReady { port: 6180 },
                json!({"type": "listener_ready", "port": 6180}),
            ),
            (
                EngineEvent::NetworkUnhealthy {
                    reason: NetworkUnhealthyReason::DataPlaneDisconnected,
                },
                json!({"type": "network_unhealthy", "reason": "data_plane_disconnected"}),
            ),
            (
                EngineEvent::FatalError {
                    code: EngineErrorCode::AuthFailed,
                    secondary_code: None,
                },
                json!({"type": "fatal_error", "code": "AUTH_FAILED"}),
            ),
            (
                EngineEvent::FatalError {
                    code: EngineErrorCode::UnsupportedAuthentication,
                    secondary_code: None,
                },
                json!({"type": "fatal_error", "code": "UNSUPPORTED_AUTHENTICATION"}),
            ),
            (
                EngineEvent::FatalError {
                    code: EngineErrorCode::AuthIndeterminate,
                    secondary_code: Some(EngineErrorCode::AuthCleanupUnconfirmed),
                },
                json!({
                    "type": "fatal_error",
                    "code": "AUTH_INDETERMINATE",
                    "secondaryCode": "AUTH_CLEANUP_UNCONFIRMED",
                }),
            ),
            (
                EngineEvent::FatalError {
                    code: EngineErrorCode::DataPlaneShutdownFailed,
                    secondary_code: None,
                },
                json!({"type": "fatal_error", "code": "DATA_PLANE_SHUTDOWN_FAILED"}),
            ),
            (
                EngineEvent::Stopped {
                    reason: StopReason::UserRequested,
                    generation: u64::MAX,
                },
                json!({"type": "stopped", "reason": "user_requested", "generation": u64::MAX}),
            ),
        ];

        for (event, expected) in cases {
            let encoded = serde_json::to_value(event).unwrap();
            assert_eq!(encoded, expected);
        }
    }

    #[test]
    fn emitter_writes_one_bounded_json_object_per_line() {
        let mut emitter = EngineEventEmitter::new(Vec::new());
        emitter.emit(&EngineEvent::hello()).unwrap();
        emitter
            .emit(&EngineEvent::StateChanged {
                state: EngineState::Connected,
                generation: 9,
            })
            .unwrap();
        let output = emitter.into_inner();
        let lines = output.split(|byte| *byte == b'\n').collect::<Vec<_>>();
        assert_eq!(lines.len(), 3);
        assert!(lines[2].is_empty());
        for line in &lines[..2] {
            assert!(line.len() < MAX_ENGINE_EVENT_BYTES);
            serde_json::from_slice::<Value>(line).unwrap();
        }
    }

    #[test]
    fn v2_control_responses_share_stdout_without_changing_v1_events() {
        let mut emitter = EngineEventEmitter::new(Vec::new());
        emitter.emit(&EngineEvent::hello()).unwrap();
        emitter
            .emit_control(&ControlResponse::Result {
                api_version: 2,
                request_id: 8,
                status: crate::engine::control::ControlStatus::Accepted,
            })
            .unwrap();
        let output = emitter.into_inner();
        let values = output
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(values[0]["apiVersion"], 1);
        assert_eq!(values[1]["apiVersion"], 2);
        assert_eq!(values[1]["requestId"], 8);
    }

    #[test]
    fn v3_auth_events_and_responses_share_stdout_without_secret_fields() {
        use crate::engine::auth_control::{AuthControlErrorCode, auth_error_response};
        use crate::engine::auth_transaction::{ChallengeKind, ChallengeView, TransactionId};

        let challenge =
            ChallengeView::new(&TransactionId::from_bytes([6; 16]), 1, ChallengeKind::Otp).unwrap();
        let mut emitter = EngineEventEmitter::new(Vec::new());
        emitter
            .emit_auth_event(&AuthControlEvent::ChallengeRequired {
                api_version: 3,
                challenge,
            })
            .unwrap();
        emitter
            .emit_auth_control(&auth_error_response(
                7,
                AuthControlErrorCode::TransactionClosed,
            ))
            .unwrap();
        let output = String::from_utf8(emitter.into_inner()).unwrap();
        assert!(output.contains("auth_challenge_required"));
        assert!(output.contains("transaction_closed"));
        for forbidden in ["response", "cookie", "csrf"] {
            assert!(!output.to_ascii_lowercase().contains(forbidden));
        }
    }

    #[test]
    fn oversized_serialization_is_rejected_before_writing() {
        #[derive(Serialize)]
        struct Oversized<'a> {
            value: &'a str,
        }
        let value = "x".repeat(MAX_ENGINE_EVENT_BYTES);
        assert!(encode_bounded_json_line(&Oversized { value: &value }).is_err());
    }

    #[test]
    fn machine_events_expose_only_bounded_display_metadata_and_no_credentials() {
        let events = [
            EngineEvent::hello(),
            EngineEvent::ClientIpAssigned {
                family: AddressFamily::Ipv4,
                address: Ipv4Addr::new(10, 20, 30, 40),
            },
            EngineEvent::FatalError {
                code: EngineErrorCode::AuthFailed,
                secondary_code: Some(EngineErrorCode::AuthCleanupUnconfirmed),
            },
        ];
        let encoded = serde_json::to_string(&events).unwrap();
        for forbidden in [
            "sensitive-user-fixture",
            "test-password-value",
            "0123456789abcdef0123456789abcdef0123456789abcdef",
            "127.0.0.1",
            "10.0.0.1",
        ] {
            assert!(!encoded.contains(forbidden));
        }
        for event in serde_json::from_str::<Vec<Value>>(&encoded).unwrap() {
            let object = event.as_object().unwrap();
            for forbidden_key in ["username", "password", "token", "session"] {
                assert!(!object.contains_key(forbidden_key));
            }
        }
    }
}
