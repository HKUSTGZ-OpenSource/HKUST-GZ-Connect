//! Bounded, secret-free messages for the bidirectional Engine Control API v2.
//!
//! This module deliberately does not open a TCP listener. The opt-in production
//! transport retains the engine's already inherited private stdin pipe after
//! its fixed credential prefix; tests and future supervisors can also place
//! [`ControlFrameReader`] / [`ControlFrameWriter`] over another private byte
//! stream. This avoids turning loopback into an unauthenticated control surface.
//!
//! Gateway credentials continue to use the existing bounded stdin contract;
//! engine lifecycle events continue to use stdout Event API v1. Control v2
//! messages contain no free-form payload fields, so credentials, gateway
//! tokens, URLs, and network destinations cannot be represented on this wire.

use crate::engine::provider::{CapabilityAvailability, ProviderCapabilityReport};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, VecDeque};
use std::io::{Read, Write};

pub const ENGINE_CONTROL_API_VERSION: u8 = 2;
pub const MAX_CONTROL_FRAME_BYTES: usize = 2 * 1024;
pub const MAX_OFFERED_VERSIONS: usize = 4;
pub const MAX_ACTIVE_REQUESTS: usize = 32;
pub const MAX_TRACKED_REQUEST_IDS: usize = 256;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub enum ControlCapability {
    #[serde(rename = "engine.shutdown")]
    EngineShutdown,
    #[serde(rename = "request.cancel")]
    RequestCancel,
    #[serde(rename = "control.close")]
    ControlClose,
    #[serde(rename = "provider.capabilities")]
    ProviderCapabilities,
    #[serde(rename = "auth.captcha")]
    AuthCaptcha,
    #[serde(rename = "auth.sms")]
    AuthSms,
    #[serde(rename = "auth.token")]
    AuthToken,
    #[serde(rename = "auth.certificate")]
    AuthCertificate,
    #[serde(rename = "auth.hid")]
    AuthHid,
    #[serde(rename = "auth.sso")]
    AuthSso,
    #[serde(rename = "auth.device")]
    AuthDevice,
    #[serde(rename = "auth.unknown_secondary")]
    AuthUnknownSecondary,
    #[serde(rename = "resource.catalogue")]
    ResourceCatalogue,
    #[serde(rename = "resource.authorization_decision")]
    ResourceAuthorizationDecision,
    #[serde(rename = "transport.web_vpn")]
    TransportWebVpn,
}

const CONTROL_CAPABILITIES: [ControlCapability; 4] = [
    ControlCapability::EngineShutdown,
    ControlCapability::RequestCancel,
    ControlCapability::ControlClose,
    ControlCapability::ProviderCapabilities,
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "name", rename_all = "snake_case", deny_unknown_fields)]
pub enum ControlCommand {
    Shutdown,
    ProviderCapabilities,
    RequireCapability { capability: ControlCapability },
}

#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ControlRequest {
    Hello {
        #[serde(rename = "requestId")]
        request_id: u64,
        versions: Vec<u8>,
    },
    Request {
        #[serde(rename = "apiVersion")]
        api_version: u8,
        #[serde(rename = "requestId")]
        request_id: u64,
        command: ControlCommand,
    },
    Cancel {
        #[serde(rename = "apiVersion")]
        api_version: u8,
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "requestToCancel")]
        request_to_cancel: u64,
    },
    Close {
        #[serde(rename = "apiVersion")]
        api_version: u8,
        #[serde(rename = "requestId")]
        request_id: u64,
    },
}

impl ControlRequest {
    const fn request_id(&self) -> u64 {
        match self {
            Self::Hello { request_id, .. }
            | Self::Request { request_id, .. }
            | Self::Cancel { request_id, .. }
            | Self::Close { request_id, .. } => *request_id,
        }
    }

    const fn api_version(&self) -> Option<u8> {
        match self {
            Self::Hello { .. } => None,
            Self::Request { api_version, .. }
            | Self::Cancel { api_version, .. }
            | Self::Close { api_version, .. } => Some(*api_version),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlStatus {
    Accepted,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ControlProtocolError {
    HandshakeRequired,
    HandshakeAlreadyComplete,
    InvalidRequest,
    DuplicateRequestId,
    VersionUnsupported {
        #[serde(rename = "supportedVersions")]
        supported_versions: [u8; 1],
    },
    TooManyActiveRequests,
    RequestNotFound,
    ConnectionClosed,
    CapabilityContextUnavailable,
    UnsupportedCapability {
        capability: ControlCapability,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlResponse {
    #[serde(rename = "control_hello")]
    Hello {
        #[serde(rename = "apiVersion")]
        api_version: u8,
        #[serde(rename = "requestId")]
        request_id: u64,
        capabilities: [ControlCapability; 4],
    },
    #[serde(rename = "control_result")]
    Result {
        #[serde(rename = "apiVersion")]
        api_version: u8,
        #[serde(rename = "requestId")]
        request_id: u64,
        status: ControlStatus,
    },
    #[serde(rename = "provider_capabilities")]
    ProviderCapabilities {
        #[serde(rename = "apiVersion")]
        api_version: u8,
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "profileId")]
        profile_id: String,
        #[serde(rename = "profileRevision")]
        profile_revision: u64,
        #[serde(rename = "engineGeneration")]
        engine_generation: u64,
        compiled: std::collections::BTreeMap<String, CapabilityAvailability>,
        provider: std::collections::BTreeMap<String, CapabilityAvailability>,
    },
    #[serde(rename = "control_error")]
    Error {
        #[serde(rename = "apiVersion")]
        api_version: u8,
        #[serde(rename = "requestId")]
        request_id: u64,
        error: ControlProtocolError,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlAction {
    Shutdown {
        request_id: u64,
    },
    Cancel {
        request_id: u64,
        request_to_cancel: u64,
    },
    Close {
        request_id: u64,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlExchange {
    pub response: ControlResponse,
    pub action: Option<ControlAction>,
}

impl ControlExchange {
    fn response(response: ControlResponse) -> Self {
        Self {
            response,
            action: None,
        }
    }

    fn action(response: ControlResponse, action: ControlAction) -> Self {
        Self {
            response,
            action: Some(action),
        }
    }
}

#[derive(Default)]
pub struct ControlSession {
    negotiated: bool,
    closed: bool,
    active_requests: BTreeSet<u64>,
    recent_request_ids: BTreeSet<u64>,
    request_order: VecDeque<u64>,
    provider_context: Option<ProviderCapabilityContext>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProviderCapabilityContext {
    profile_id: String,
    profile_revision: u64,
    engine_generation: u64,
    report: ProviderCapabilityReport,
}

impl ControlSession {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_provider_capabilities(
        profile_id: String,
        profile_revision: u64,
        engine_generation: u64,
        report: ProviderCapabilityReport,
    ) -> Result<Self> {
        if profile_id.is_empty()
            || profile_id.len() > 64
            || profile_revision == 0
            || engine_generation == 0
        {
            return Err(Error("provider capability context is invalid".into()));
        }
        Ok(Self {
            provider_context: Some(ProviderCapabilityContext {
                profile_id,
                profile_revision,
                engine_generation,
                report,
            }),
            ..Self::default()
        })
    }

    pub fn handle(&mut self, request: ControlRequest) -> ControlExchange {
        let request_id = request.request_id();
        if request_id == 0 {
            return self.error(request_id, ControlProtocolError::InvalidRequest);
        }
        if self.recent_request_ids.contains(&request_id) {
            return self.error(request_id, ControlProtocolError::DuplicateRequestId);
        }
        self.remember_request_id(request_id);

        if self.closed {
            return self.error(request_id, ControlProtocolError::ConnectionClosed);
        }
        if request
            .api_version()
            .is_some_and(|version| version != ENGINE_CONTROL_API_VERSION)
        {
            return self.version_unsupported(request_id);
        }

        match request {
            ControlRequest::Hello {
                request_id,
                versions,
            } => self.hello(request_id, &versions),
            ControlRequest::Request {
                request_id,
                command,
                ..
            } => {
                if !self.negotiated {
                    return self.error(request_id, ControlProtocolError::HandshakeRequired);
                }
                self.command(request_id, command)
            }
            ControlRequest::Cancel {
                request_id,
                request_to_cancel,
                ..
            } => {
                if !self.negotiated {
                    return self.error(request_id, ControlProtocolError::HandshakeRequired);
                }
                self.cancel(request_id, request_to_cancel)
            }
            ControlRequest::Close { request_id, .. } => {
                if !self.negotiated {
                    return self.error(request_id, ControlProtocolError::HandshakeRequired);
                }
                self.closed = true;
                ControlExchange::action(
                    self.result(request_id, ControlStatus::Accepted),
                    ControlAction::Close { request_id },
                )
            }
        }
    }

    pub fn complete(&mut self, request_id: u64) -> bool {
        self.active_requests.remove(&request_id)
    }

    fn hello(&mut self, request_id: u64, versions: &[u8]) -> ControlExchange {
        if self.negotiated {
            return self.error(request_id, ControlProtocolError::HandshakeAlreadyComplete);
        }
        if versions.is_empty()
            || versions.len() > MAX_OFFERED_VERSIONS
            || !versions.contains(&ENGINE_CONTROL_API_VERSION)
        {
            return self.version_unsupported(request_id);
        }
        self.negotiated = true;
        ControlExchange::response(ControlResponse::Hello {
            api_version: ENGINE_CONTROL_API_VERSION,
            request_id,
            capabilities: CONTROL_CAPABILITIES,
        })
    }

    fn command(&mut self, request_id: u64, command: ControlCommand) -> ControlExchange {
        match command {
            ControlCommand::Shutdown => {
                if self.active_requests.len() >= MAX_ACTIVE_REQUESTS {
                    return self.error(request_id, ControlProtocolError::TooManyActiveRequests);
                }
                self.active_requests.insert(request_id);
                ControlExchange::action(
                    self.result(request_id, ControlStatus::Accepted),
                    ControlAction::Shutdown { request_id },
                )
            }
            ControlCommand::ProviderCapabilities => {
                let Some(context) = &self.provider_context else {
                    return self.error(
                        request_id,
                        ControlProtocolError::CapabilityContextUnavailable,
                    );
                };
                ControlExchange::response(ControlResponse::ProviderCapabilities {
                    api_version: ENGINE_CONTROL_API_VERSION,
                    request_id,
                    profile_id: context.profile_id.clone(),
                    profile_revision: context.profile_revision,
                    engine_generation: context.engine_generation,
                    compiled: context.report.compiled().clone(),
                    provider: context.report.provider().clone(),
                })
            }
            ControlCommand::RequireCapability { capability } => {
                if CONTROL_CAPABILITIES.contains(&capability) {
                    ControlExchange::response(self.result(request_id, ControlStatus::Accepted))
                } else {
                    self.error(
                        request_id,
                        ControlProtocolError::UnsupportedCapability { capability },
                    )
                }
            }
        }
    }

    fn cancel(&mut self, request_id: u64, request_to_cancel: u64) -> ControlExchange {
        if !self.active_requests.remove(&request_to_cancel) {
            return self.error(request_id, ControlProtocolError::RequestNotFound);
        }
        ControlExchange::action(
            self.result(request_id, ControlStatus::Cancelled),
            ControlAction::Cancel {
                request_id,
                request_to_cancel,
            },
        )
    }

    fn remember_request_id(&mut self, request_id: u64) {
        if self.request_order.len() == MAX_TRACKED_REQUEST_IDS
            && let Some(expired) = self.request_order.pop_front()
        {
            self.recent_request_ids.remove(&expired);
        }
        self.request_order.push_back(request_id);
        self.recent_request_ids.insert(request_id);
    }

    fn result(&self, request_id: u64, status: ControlStatus) -> ControlResponse {
        ControlResponse::Result {
            api_version: ENGINE_CONTROL_API_VERSION,
            request_id,
            status,
        }
    }

    fn error(&self, request_id: u64, error: ControlProtocolError) -> ControlExchange {
        ControlExchange::response(ControlResponse::Error {
            api_version: ENGINE_CONTROL_API_VERSION,
            request_id,
            error,
        })
    }

    fn version_unsupported(&self, request_id: u64) -> ControlExchange {
        self.error(
            request_id,
            ControlProtocolError::VersionUnsupported {
                supported_versions: [ENGINE_CONTROL_API_VERSION],
            },
        )
    }
}

pub struct ControlFrameReader<R> {
    reader: R,
    buffered: Vec<u8>,
}

impl<R: Read> ControlFrameReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            buffered: Vec::with_capacity(256),
        }
    }

    pub fn read_request(&mut self) -> Result<Option<ControlRequest>> {
        loop {
            if let Some(newline) = self.buffered.iter().position(|byte| *byte == b'\n') {
                if newline + 1 > MAX_CONTROL_FRAME_BYTES {
                    return Err(Error("engine control frame exceeds the wire limit".into()));
                }
                let mut frame = self.buffered.drain(..=newline).collect::<Vec<_>>();
                frame.pop();
                return decode_control_request(&frame).map(Some);
            }
            if self.buffered.len() >= MAX_CONTROL_FRAME_BYTES {
                return Err(Error("engine control frame exceeds the wire limit".into()));
            }
            let mut chunk = [0_u8; 256];
            let remaining = MAX_CONTROL_FRAME_BYTES - self.buffered.len();
            let read_capacity = remaining.min(chunk.len());
            let read = self
                .reader
                .read(&mut chunk[..read_capacity])
                .map_err(|error| Error(format!("cannot read engine control frame: {error}")))?;
            if read == 0 {
                if self.buffered.is_empty() {
                    return Ok(None);
                }
                return Err(Error("engine control frame is truncated".into()));
            }
            self.buffered.extend_from_slice(&chunk[..read]);
        }
    }
}

pub struct ControlFrameWriter<W> {
    writer: W,
}

impl<W: Write> ControlFrameWriter<W> {
    pub fn new(writer: W) -> Self {
        Self { writer }
    }

    pub fn write_response(&mut self, response: &ControlResponse) -> Result<()> {
        let encoded = encode_control_response(response)?;
        self.writer
            .write_all(&encoded)
            .map_err(|error| Error(format!("cannot write engine control frame: {error}")))?;
        self.writer
            .flush()
            .map_err(|error| Error(format!("cannot flush engine control frame: {error}")))
    }

    #[cfg(test)]
    fn into_inner(self) -> W {
        self.writer
    }
}

pub fn decode_control_request(frame: &[u8]) -> Result<ControlRequest> {
    if frame.is_empty() || frame.len() + 1 > MAX_CONTROL_FRAME_BYTES {
        return Err(Error("engine control frame has an invalid length".into()));
    }
    serde_json::from_slice(frame)
        .map_err(|_| Error("engine control frame is not a valid v2 request".into()))
}

pub fn encode_control_response(response: &ControlResponse) -> Result<Vec<u8>> {
    let mut encoded = serde_json::to_vec(response)
        .map_err(|error| Error(format!("cannot serialize engine control response: {error}")))?;
    if encoded.len() + 1 > MAX_CONTROL_FRAME_BYTES {
        return Err(Error(
            "engine control response exceeds the wire limit".into(),
        ));
    }
    encoded.push(b'\n');
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::provider::CapabilityModel;
    use serde_json::{Value, json};
    use std::io::Cursor;

    fn hello(request_id: u64) -> ControlRequest {
        ControlRequest::Hello {
            request_id,
            versions: vec![ENGINE_CONTROL_API_VERSION],
        }
    }

    #[test]
    fn v2_handshake_has_a_stable_bounded_schema() {
        let exchange = ControlSession::new().handle(hello(7));
        assert_eq!(exchange.action, None);
        assert_eq!(
            serde_json::to_value(&exchange.response).unwrap(),
            json!({
                "type": "control_hello",
                "apiVersion": 2,
                "requestId": 7,
                "capabilities": [
                    "engine.shutdown",
                    "request.cancel",
                    "control.close",
                    "provider.capabilities"
                ],
            })
        );
        assert!(
            encode_control_response(&exchange.response).unwrap().len() <= MAX_CONTROL_FRAME_BYTES
        );
    }

    #[test]
    fn provider_capabilities_are_additive_profile_and_generation_bound() {
        let report = ProviderCapabilityReport::new(
            CapabilityModel::production_password_l3(),
            CapabilityModel::production_password_l3(),
        )
        .unwrap();
        let mut session =
            ControlSession::with_provider_capabilities("hkustgz".into(), 1, 9, report).unwrap();
        session.handle(hello(1));
        let exchange = session.handle(ControlRequest::Request {
            api_version: 2,
            request_id: 2,
            command: ControlCommand::ProviderCapabilities,
        });
        assert_eq!(exchange.action, None);
        assert!(
            encode_control_response(&exchange.response).unwrap().len() <= MAX_CONTROL_FRAME_BYTES
        );
        let value = serde_json::to_value(exchange.response).unwrap();
        assert_eq!(value["type"], "provider_capabilities");
        assert_eq!(value["profileId"], "hkustgz");
        assert_eq!(value["profileRevision"], 1);
        assert_eq!(value["engineGeneration"], 9);
        assert_eq!(value["compiled"]["auth.password"], "supported");
        assert_eq!(value["provider"]["transport.l3"], "supported");
        assert_eq!(value["provider"]["auth.sms"], "unsupported");

        let mut unbound = ControlSession::new();
        unbound.handle(hello(10));
        assert!(matches!(
            unbound
                .handle(ControlRequest::Request {
                    api_version: 2,
                    request_id: 11,
                    command: ControlCommand::ProviderCapabilities,
                })
                .response,
            ControlResponse::Error {
                error: ControlProtocolError::CapabilityContextUnavailable,
                ..
            }
        ));
    }

    #[test]
    fn shutdown_can_be_cancelled_by_request_id() {
        let mut session = ControlSession::new();
        session.handle(hello(1));
        let shutdown = session.handle(ControlRequest::Request {
            api_version: 2,
            request_id: 2,
            command: ControlCommand::Shutdown,
        });
        assert_eq!(
            shutdown.action,
            Some(ControlAction::Shutdown { request_id: 2 })
        );
        let cancelled = session.handle(ControlRequest::Cancel {
            api_version: 2,
            request_id: 3,
            request_to_cancel: 2,
        });
        assert_eq!(
            cancelled.action,
            Some(ControlAction::Cancel {
                request_id: 3,
                request_to_cancel: 2,
            })
        );
        assert!(matches!(
            cancelled.response,
            ControlResponse::Result {
                status: ControlStatus::Cancelled,
                ..
            }
        ));
    }

    #[test]
    fn unsupported_capabilities_are_typed_and_never_activated() {
        let mut session = ControlSession::new();
        session.handle(hello(1));
        for (request_id, capability) in [
            (2, ControlCapability::AuthSms),
            (3, ControlCapability::ResourceCatalogue),
            (4, ControlCapability::TransportWebVpn),
        ] {
            let exchange = session.handle(ControlRequest::Request {
                api_version: 2,
                request_id,
                command: ControlCommand::RequireCapability { capability },
            });
            assert_eq!(exchange.action, None);
            assert!(matches!(
                exchange.response,
                ControlResponse::Error {
                    error: ControlProtocolError::UnsupportedCapability { capability: value },
                    ..
                } if value == capability
            ));
        }
        let supported = session.handle(ControlRequest::Request {
            api_version: 2,
            request_id: 5,
            command: ControlCommand::RequireCapability {
                capability: ControlCapability::EngineShutdown,
            },
        });
        assert_eq!(supported.action, None);
        assert!(matches!(
            supported.response,
            ControlResponse::Result {
                status: ControlStatus::Accepted,
                ..
            }
        ));
    }

    #[test]
    fn handshake_version_ids_and_close_are_fail_closed() {
        let mut session = ControlSession::new();
        assert!(matches!(
            session
                .handle(ControlRequest::Request {
                    api_version: 2,
                    request_id: 1,
                    command: ControlCommand::Shutdown,
                })
                .response,
            ControlResponse::Error {
                error: ControlProtocolError::HandshakeRequired,
                ..
            }
        ));
        assert!(matches!(
            session
                .handle(ControlRequest::Hello {
                    request_id: 2,
                    versions: vec![1]
                })
                .response,
            ControlResponse::Error {
                error: ControlProtocolError::VersionUnsupported { .. },
                ..
            }
        ));
        session.handle(hello(3));
        assert!(matches!(
            session.handle(hello(3)).response,
            ControlResponse::Error {
                error: ControlProtocolError::DuplicateRequestId,
                ..
            }
        ));
        let closed = session.handle(ControlRequest::Close {
            api_version: 2,
            request_id: 4,
        });
        assert_eq!(closed.action, Some(ControlAction::Close { request_id: 4 }));
        assert!(matches!(
            session
                .handle(ControlRequest::Close {
                    api_version: 2,
                    request_id: 5
                })
                .response,
            ControlResponse::Error {
                error: ControlProtocolError::ConnectionClosed,
                ..
            }
        ));
    }

    #[test]
    fn codec_is_fragment_safe_bounded_and_rejects_unknown_fields() {
        let wire = b"{\"type\":\"hello\",\"requestId\":9,\"versions\":[2]}\n{\"type\":\"close\",\"apiVersion\":2,\"requestId\":10}\n";
        let mut reader = ControlFrameReader::new(Cursor::new(wire));
        assert_eq!(reader.read_request().unwrap(), Some(hello(9)));
        assert!(matches!(
            reader.read_request().unwrap(),
            Some(ControlRequest::Close { request_id: 10, .. })
        ));
        assert_eq!(reader.read_request().unwrap(), None);

        let unknown = br#"{"type":"hello","requestId":1,"versions":[2],"password":"private"}"#;
        assert!(decode_control_request(unknown).is_err());
        let oversized = vec![b'x'; MAX_CONTROL_FRAME_BYTES];
        assert!(decode_control_request(&oversized).is_err());
        assert!(
            ControlFrameReader::new(Cursor::new(br#"{"type":"hello"}"#))
                .read_request()
                .is_err()
        );
    }

    #[test]
    fn response_writer_emits_one_line_and_schema_has_no_secret_or_destination_fields() {
        let response = ControlSession::new().handle(hello(1)).response;
        let mut writer = ControlFrameWriter::new(Vec::new());
        writer.write_response(&response).unwrap();
        let wire = writer.into_inner();
        assert_eq!(wire.iter().filter(|byte| **byte == b'\n').count(), 1);
        let value: Value = serde_json::from_slice(&wire[..wire.len() - 1]).unwrap();
        let encoded = value.to_string().to_ascii_lowercase();
        for forbidden in [
            "username",
            "password",
            "cookie",
            "access_token",
            "refresh_token",
            "destination",
            "hostname",
            "url",
        ] {
            assert!(!encoded.contains(forbidden));
        }
    }

    #[test]
    fn request_tracking_memory_is_bounded() {
        let mut session = ControlSession::new();
        session.handle(hello(1));
        for request_id in 2..=(MAX_TRACKED_REQUEST_IDS as u64 + 20) {
            session.handle(ControlRequest::Request {
                api_version: 2,
                request_id,
                command: ControlCommand::RequireCapability {
                    capability: ControlCapability::ResourceCatalogue,
                },
            });
        }
        assert_eq!(session.request_order.len(), MAX_TRACKED_REQUEST_IDS);
        assert_eq!(session.recent_request_ids.len(), MAX_TRACKED_REQUEST_IDS);
    }
}
