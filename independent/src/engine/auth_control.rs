//! Secret-bearing interactive-auth control schema (API v3).
//!
//! Control v2 remains secret-free and unchanged. This separate schema is
//! bounded, uses the inherited private pipe only, zeroizes the raw frame and
//! response value, and emits only sanitized [`ChallengeView`] metadata.
//! Production does not advertise v3 until a reviewed interactive provider is
//! wired; the codec/session are exercised with synthetic transactions.

use crate::engine::auth_transaction::{
    AuthCommandContext, AuthProgress, AuthTransaction, AuthTransactionOwner, ChallengeView,
    MAX_AUTH_RESPONSE_BYTES, SecretBytes,
};
use crate::{Error, ErrorKind, Result};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use std::fmt::{Debug, Formatter};
use std::io::{Read, Write};
use zeroize::Zeroizing;

pub const INTERACTIVE_AUTH_CONTROL_API_VERSION: u8 = 3;
pub const MAX_AUTH_CONTROL_FRAME_BYTES: usize = 8 * 1024;

pub struct AuthResponseSecret(Zeroizing<String>);

impl AuthResponseSecret {
    fn into_secret_bytes(self) -> Result<SecretBytes> {
        SecretBytes::new(self.0.as_bytes())
    }
}

impl Debug for AuthResponseSecret {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("AuthResponseSecret(<redacted>)")
    }
}

impl<'de> Deserialize<'de> for AuthResponseSecret {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Zeroizing::new(String::deserialize(deserializer)?);
        if value.is_empty() || value.len() > MAX_AUTH_RESPONSE_BYTES {
            return Err(D::Error::custom(
                "authentication response has an invalid length",
            ));
        }
        Ok(Self(value))
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "name", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthControlCommand {
    Respond { response: AuthResponseSecret },
    Resend,
    Cancel,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthControlRequest {
    AuthRequest {
        #[serde(rename = "apiVersion")]
        api_version: u8,
        #[serde(rename = "requestId")]
        request_id: u64,
        generation: u64,
        #[serde(rename = "transactionId")]
        transaction_id: String,
        #[serde(rename = "challengeEpoch")]
        challenge_epoch: u32,
        command: AuthControlCommand,
    },
}

impl AuthControlRequest {
    pub const fn request_id(&self) -> u64 {
        match self {
            Self::AuthRequest { request_id, .. } => *request_id,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthControlErrorCode {
    InvalidRequest,
    StaleContext,
    DuplicateRequest,
    UnsupportedChallenge,
    ResendUnavailable,
    ChallengeExpired,
    LimitExceeded,
    ProviderFailure,
    TransactionClosed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthControlResponse {
    #[serde(rename = "auth_challenge")]
    Challenge {
        #[serde(rename = "apiVersion")]
        api_version: u8,
        #[serde(rename = "requestId")]
        request_id: u64,
        challenge: ChallengeView,
    },
    #[serde(rename = "auth_complete")]
    Complete {
        #[serde(rename = "apiVersion")]
        api_version: u8,
        #[serde(rename = "requestId")]
        request_id: u64,
    },
    #[serde(rename = "auth_cancelled")]
    Cancelled {
        #[serde(rename = "apiVersion")]
        api_version: u8,
        #[serde(rename = "requestId")]
        request_id: u64,
    },
    #[serde(rename = "auth_error")]
    Error {
        #[serde(rename = "apiVersion")]
        api_version: u8,
        #[serde(rename = "requestId")]
        request_id: u64,
        code: AuthControlErrorCode,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthControlEvent {
    #[serde(rename = "auth_challenge_required")]
    ChallengeRequired {
        #[serde(rename = "apiVersion")]
        api_version: u8,
        challenge: ChallengeView,
    },
    #[serde(rename = "auth_challenge_updated")]
    ChallengeUpdated {
        #[serde(rename = "apiVersion")]
        api_version: u8,
        challenge: ChallengeView,
    },
}

pub enum AuthControlAction<S> {
    None,
    Authenticated(S),
    Cancelled,
}

pub struct AuthControlExchange<S> {
    pub response: AuthControlResponse,
    pub action: AuthControlAction<S>,
}

pub struct AuthControlSession<T: AuthTransaction> {
    owner: Option<AuthTransactionOwner<T>>,
}

impl<T: AuthTransaction> AuthControlSession<T> {
    pub fn new(owner: AuthTransactionOwner<T>) -> Self {
        Self { owner: Some(owner) }
    }

    pub fn initial_event(&self) -> Result<AuthControlEvent> {
        let challenge = self
            .owner
            .as_ref()
            .ok_or_else(transaction_closed)?
            .public_challenge()
            .clone();
        Ok(AuthControlEvent::ChallengeRequired {
            api_version: INTERACTIVE_AUTH_CONTROL_API_VERSION,
            challenge,
        })
    }

    pub fn remaining_lifetime(&self) -> Result<std::time::Duration> {
        self.owner
            .as_ref()
            .ok_or_else(transaction_closed)?
            .remaining_lifetime()
    }

    pub async fn wait_for_deadline(&self) -> Result<()> {
        tokio::time::sleep(self.remaining_lifetime()?).await;
        Ok(())
    }

    /// Called by the Engine-owned deadline timer even when the renderer sends
    /// no command. Expiry is terminal before provider cleanup is attempted.
    pub fn expire_if_due(&mut self) -> Result<bool> {
        let result = self
            .owner
            .as_mut()
            .ok_or_else(transaction_closed)?
            .expire_if_due();
        let terminal = self.owner.as_ref().is_some_and(|owner| !owner.is_active());
        if terminal {
            self.owner.take();
        }
        result
    }

    pub fn handle(&mut self, request: AuthControlRequest) -> AuthControlExchange<T::Session> {
        let AuthControlRequest::AuthRequest {
            api_version,
            request_id,
            generation,
            transaction_id,
            challenge_epoch,
            command,
        } = request;
        if api_version != INTERACTIVE_AUTH_CONTROL_API_VERSION
            || request_id == 0
            || !valid_transaction_id(&transaction_id)
            || challenge_epoch == 0
        {
            return exchange_error(request_id, AuthControlErrorCode::InvalidRequest);
        }
        let context = AuthCommandContext {
            generation,
            transaction_id: &transaction_id,
            challenge_epoch,
            request_id,
        };
        match command {
            AuthControlCommand::Respond { response } => {
                let secret = match response.into_secret_bytes() {
                    Ok(secret) => secret,
                    Err(error) => return self.error(request_id, error),
                };
                let result = self
                    .owner
                    .as_mut()
                    .ok_or_else(transaction_closed)
                    .and_then(|owner| owner.respond(context, secret));
                match result {
                    Ok(AuthProgress::Authenticated(session)) => {
                        self.owner.take();
                        AuthControlExchange {
                            response: AuthControlResponse::Complete {
                                api_version: INTERACTIVE_AUTH_CONTROL_API_VERSION,
                                request_id,
                            },
                            action: AuthControlAction::Authenticated(session),
                        }
                    }
                    Ok(AuthProgress::ChallengeRequired(challenge)) => AuthControlExchange {
                        response: AuthControlResponse::Challenge {
                            api_version: INTERACTIVE_AUTH_CONTROL_API_VERSION,
                            request_id,
                            challenge,
                        },
                        action: AuthControlAction::None,
                    },
                    Err(error) => self.error(request_id, error),
                }
            }
            AuthControlCommand::Resend => {
                let result = self
                    .owner
                    .as_mut()
                    .ok_or_else(transaction_closed)
                    .and_then(|owner| owner.resend(context));
                match result {
                    Ok(challenge) => AuthControlExchange {
                        response: AuthControlResponse::Challenge {
                            api_version: INTERACTIVE_AUTH_CONTROL_API_VERSION,
                            request_id,
                            challenge,
                        },
                        action: AuthControlAction::None,
                    },
                    Err(error) => self.error(request_id, error),
                }
            }
            AuthControlCommand::Cancel => {
                let result = self
                    .owner
                    .as_mut()
                    .ok_or_else(transaction_closed)
                    .and_then(|owner| owner.cancel(context));
                // Context validation happens before the owner consumes its
                // provider transaction. A stale or duplicate cancel therefore
                // leaves the valid transaction intact. Once provider cleanup
                // has started, success and failure are both terminal: the
                // provider state is no longer safe to reuse.
                let terminal = self.owner.as_ref().is_some_and(|owner| !owner.is_active());
                if terminal {
                    self.owner.take();
                }
                match result {
                    Ok(()) => AuthControlExchange {
                        response: AuthControlResponse::Cancelled {
                            api_version: INTERACTIVE_AUTH_CONTROL_API_VERSION,
                            request_id,
                        },
                        action: AuthControlAction::Cancelled,
                    },
                    Err(error) if terminal => AuthControlExchange {
                        response: AuthControlResponse::Error {
                            api_version: INTERACTIVE_AUTH_CONTROL_API_VERSION,
                            request_id,
                            code: auth_control_error_code(error.kind()),
                        },
                        action: AuthControlAction::Cancelled,
                    },
                    Err(error) => self.error(request_id, error),
                }
            }
        }
    }

    fn error(&mut self, request_id: u64, error: Error) -> AuthControlExchange<T::Session> {
        let code = auth_control_error_code(error.kind());
        if matches!(
            error.kind(),
            ErrorKind::AuthenticationExpired
                | ErrorKind::AuthenticationLimitExceeded
                | ErrorKind::Lifecycle
        ) && let Some(owner) = self.owner.take()
        {
            let _ = owner.abort();
        }
        exchange_error(request_id, code)
    }
}

pub struct AuthControlFrameReader<R> {
    reader: R,
    buffered: Zeroizing<Vec<u8>>,
}

impl<R: Read> AuthControlFrameReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            buffered: Zeroizing::new(Vec::with_capacity(256)),
        }
    }

    pub fn read_request(&mut self) -> Result<Option<AuthControlRequest>> {
        loop {
            if let Some(newline) = self.buffered.iter().position(|byte| *byte == b'\n') {
                if newline + 1 > MAX_AUTH_CONTROL_FRAME_BYTES {
                    self.buffered.clear();
                    return Err(auth_control_error(
                        "auth control frame exceeds the wire limit",
                    ));
                }
                let mut frame = Zeroizing::new(self.buffered.drain(..=newline).collect::<Vec<_>>());
                frame.pop();
                return decode_auth_control_request(frame.as_slice()).map(Some);
            }
            if self.buffered.len() >= MAX_AUTH_CONTROL_FRAME_BYTES {
                self.buffered.clear();
                return Err(auth_control_error(
                    "auth control frame exceeds the wire limit",
                ));
            }
            let mut chunk = Zeroizing::new([0_u8; 256]);
            let remaining = MAX_AUTH_CONTROL_FRAME_BYTES - self.buffered.len();
            let capacity = remaining.min(chunk.len());
            let read = self
                .reader
                .read(&mut chunk[..capacity])
                .map_err(|_| auth_control_error("cannot read auth control frame"))?;
            if read == 0 {
                if self.buffered.is_empty() {
                    return Ok(None);
                }
                self.buffered.clear();
                return Err(auth_control_error("auth control frame is truncated"));
            }
            self.buffered.extend_from_slice(&chunk[..read]);
        }
    }
}

pub struct AuthControlFrameWriter<W> {
    writer: W,
}

impl<W: Write> AuthControlFrameWriter<W> {
    pub fn new(writer: W) -> Self {
        Self { writer }
    }

    pub fn write_response(&mut self, response: &AuthControlResponse) -> Result<()> {
        self.write(
            &serde_json::to_vec(response)
                .map_err(|_| auth_control_error("cannot serialize auth control response"))?,
        )
    }

    pub fn write_event(&mut self, event: &AuthControlEvent) -> Result<()> {
        self.write(
            &serde_json::to_vec(event)
                .map_err(|_| auth_control_error("cannot serialize auth control event"))?,
        )
    }

    fn write(&mut self, encoded: &[u8]) -> Result<()> {
        if encoded.len() + 1 > MAX_AUTH_CONTROL_FRAME_BYTES {
            return Err(auth_control_error(
                "auth control output exceeds the wire limit",
            ));
        }
        self.writer
            .write_all(encoded)
            .and_then(|_| self.writer.write_all(b"\n"))
            .and_then(|_| self.writer.flush())
            .map_err(|_| auth_control_error("cannot write auth control output"))
    }
}

pub fn decode_auth_control_request(frame: &[u8]) -> Result<AuthControlRequest> {
    if frame.is_empty() || frame.len() + 1 > MAX_AUTH_CONTROL_FRAME_BYTES {
        return Err(auth_control_error(
            "auth control frame has an invalid length",
        ));
    }
    serde_json::from_slice(frame).map_err(|_| auth_control_error("auth control frame is invalid"))
}

fn auth_control_error_code(kind: ErrorKind) -> AuthControlErrorCode {
    match kind {
        ErrorKind::AuthenticationStaleContext => AuthControlErrorCode::StaleContext,
        ErrorKind::DuplicateRequest => AuthControlErrorCode::DuplicateRequest,
        ErrorKind::UnsupportedCapability => AuthControlErrorCode::UnsupportedChallenge,
        ErrorKind::ResendUnavailable => AuthControlErrorCode::ResendUnavailable,
        ErrorKind::AuthenticationExpired => AuthControlErrorCode::ChallengeExpired,
        ErrorKind::AuthenticationLimitExceeded => AuthControlErrorCode::LimitExceeded,
        ErrorKind::Lifecycle => AuthControlErrorCode::TransactionClosed,
        _ => AuthControlErrorCode::ProviderFailure,
    }
}

fn valid_transaction_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn exchange_error<S>(request_id: u64, code: AuthControlErrorCode) -> AuthControlExchange<S> {
    AuthControlExchange {
        response: AuthControlResponse::Error {
            api_version: INTERACTIVE_AUTH_CONTROL_API_VERSION,
            request_id,
            code,
        },
        action: AuthControlAction::None,
    }
}

pub fn auth_error_response(request_id: u64, code: AuthControlErrorCode) -> AuthControlResponse {
    AuthControlResponse::Error {
        api_version: INTERACTIVE_AUTH_CONTROL_API_VERSION,
        request_id,
        code,
    }
}

fn auth_control_error(message: impl Into<String>) -> Error {
    Error::classified(ErrorKind::Credentials, message)
}

fn transaction_closed() -> Error {
    Error::classified(ErrorKind::Lifecycle, "auth transaction is closed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::auth_transaction::{
        AuthBudgetPolicy, AuthGatewayRequestBudget, ChallengeKind, TransactionId,
    };
    use std::io::Cursor;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    struct SyntheticTransaction {
        view: ChallengeView,
    }

    impl AuthTransaction for SyntheticTransaction {
        type Session = &'static str;

        fn public_challenge(&self) -> ChallengeView {
            self.view.clone()
        }

        fn respond(
            &mut self,
            response: SecretBytes,
            gateway_requests: &mut AuthGatewayRequestBudget<'_>,
        ) -> Result<AuthProgress<Self::Session, ChallengeView>> {
            gateway_requests.reserve_request()?;
            if response.as_bytes() == b"accepted" {
                Ok(AuthProgress::Authenticated("session"))
            } else {
                Ok(AuthProgress::ChallengeRequired(self.view.clone()))
            }
        }

        fn resend(
            &mut self,
            gateway_requests: &mut AuthGatewayRequestBudget<'_>,
        ) -> Result<ChallengeView> {
            gateway_requests.reserve_request()?;
            Err(Error::classified(ErrorKind::ResendUnavailable, "fixture"))
        }

        fn cancel(self) -> Result<()> {
            Ok(())
        }
    }

    fn session() -> AuthControlSession<SyntheticTransaction> {
        let id = TransactionId::from_bytes([4; 16]);
        let view = ChallengeView::new(&id, 1, ChallengeKind::Otp).unwrap();
        let owner = AuthTransactionOwner::new(9, SyntheticTransaction { view }).unwrap();
        AuthControlSession::new(owner)
    }

    struct ObservedCancelTransaction {
        view: ChallengeView,
        cancel_calls: Arc<AtomicUsize>,
        fail_cancel: bool,
    }

    impl AuthTransaction for ObservedCancelTransaction {
        type Session = &'static str;

        fn public_challenge(&self) -> ChallengeView {
            self.view.clone()
        }

        fn respond(
            &mut self,
            _response: SecretBytes,
            gateway_requests: &mut AuthGatewayRequestBudget<'_>,
        ) -> Result<AuthProgress<Self::Session, ChallengeView>> {
            gateway_requests.reserve_request()?;
            Ok(AuthProgress::ChallengeRequired(self.view.clone()))
        }

        fn resend(
            &mut self,
            gateway_requests: &mut AuthGatewayRequestBudget<'_>,
        ) -> Result<ChallengeView> {
            gateway_requests.reserve_request()?;
            let id = TransactionId::from_bytes([4; 16]);
            self.view = ChallengeView::new(
                &id,
                self.view.challenge_epoch().saturating_add(1),
                ChallengeKind::Otp,
            )?
            .with_resend(true, None);
            Ok(self.view.clone())
        }

        fn cancel(self) -> Result<()> {
            self.cancel_calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_cancel {
                Err(Error::classified(
                    ErrorKind::Authentication,
                    "synthetic provider cleanup failed",
                ))
            } else {
                Ok(())
            }
        }
    }

    fn observed_cancel_session(
        fail_cancel: bool,
    ) -> (
        AuthControlSession<ObservedCancelTransaction>,
        Arc<AtomicUsize>,
    ) {
        let id = TransactionId::from_bytes([4; 16]);
        let view = ChallengeView::new(&id, 1, ChallengeKind::Otp)
            .unwrap()
            .with_resend(true, None);
        let cancel_calls = Arc::new(AtomicUsize::new(0));
        let owner = AuthTransactionOwner::new(
            9,
            ObservedCancelTransaction {
                view,
                cancel_calls: Arc::clone(&cancel_calls),
                fail_cancel,
            },
        )
        .unwrap();
        (AuthControlSession::new(owner), cancel_calls)
    }

    fn request(
        request_id: u64,
        generation: u64,
        challenge_epoch: u32,
        command: &str,
    ) -> AuthControlRequest {
        decode_auth_control_request(
            format!(
                "{{\"type\":\"auth_request\",\"apiVersion\":3,\"requestId\":{request_id},\"generation\":{generation},\"transactionId\":\"04040404040404040404040404040404\",\"challengeEpoch\":{challenge_epoch},\"command\":{command}}}"
            )
            .as_bytes(),
        )
        .unwrap()
    }

    #[test]
    fn secret_frame_debug_and_errors_never_echo_the_response() {
        let raw = b"{\"type\":\"auth_request\",\"apiVersion\":3,\"requestId\":1,\"generation\":9,\"transactionId\":\"04040404040404040404040404040404\",\"challengeEpoch\":1,\"command\":{\"name\":\"respond\",\"response\":\"private-response\"}}\n";
        let mut reader = AuthControlFrameReader::new(Cursor::new(raw));
        let request = reader.read_request().unwrap().unwrap();
        assert!(!format!("{request:?}").contains("private-response"));
        assert!(reader.read_request().unwrap().is_none());

        let malformed = decode_auth_control_request(b"private-response").unwrap_err();
        assert!(!malformed.to_string().contains("private-response"));
        assert_eq!(malformed.kind(), ErrorKind::Credentials);
    }

    #[test]
    fn sanitized_event_and_response_wire_never_contain_secret_fields() {
        let mut session = session();
        let event = session.initial_event().unwrap();
        let event_json = serde_json::to_string(&event).unwrap();
        assert!(event_json.contains("auth_challenge_required"));
        for forbidden in ["response", "cookie", "csrf", "token"] {
            assert!(!event_json.to_ascii_lowercase().contains(forbidden));
        }

        let request = decode_auth_control_request(b"{\"type\":\"auth_request\",\"apiVersion\":3,\"requestId\":1,\"generation\":9,\"transactionId\":\"04040404040404040404040404040404\",\"challengeEpoch\":1,\"command\":{\"name\":\"respond\",\"response\":\"accepted\"}}").unwrap();
        let exchange = session.handle(request);
        assert!(matches!(
            exchange.action,
            AuthControlAction::Authenticated("session")
        ));
        let response = serde_json::to_string(&exchange.response).unwrap();
        assert_eq!(
            response,
            "{\"type\":\"auth_complete\",\"apiVersion\":3,\"requestId\":1}"
        );
    }

    #[test]
    fn stale_duplicate_and_resend_errors_are_stable_and_secret_free() {
        let mut session = session();
        let stale = decode_auth_control_request(b"{\"type\":\"auth_request\",\"apiVersion\":3,\"requestId\":1,\"generation\":8,\"transactionId\":\"04040404040404040404040404040404\",\"challengeEpoch\":1,\"command\":{\"name\":\"resend\"}}").unwrap();
        assert!(matches!(
            session.handle(stale).response,
            AuthControlResponse::Error {
                code: AuthControlErrorCode::StaleContext,
                ..
            }
        ));
        let resend = decode_auth_control_request(b"{\"type\":\"auth_request\",\"apiVersion\":3,\"requestId\":2,\"generation\":9,\"transactionId\":\"04040404040404040404040404040404\",\"challengeEpoch\":1,\"command\":{\"name\":\"resend\"}}").unwrap();
        assert!(matches!(
            session.handle(resend).response,
            AuthControlResponse::Error {
                code: AuthControlErrorCode::ResendUnavailable,
                ..
            }
        ));
    }

    #[test]
    fn stale_and_duplicate_cancel_keep_the_valid_transaction_active() {
        let (mut session, cancel_calls) = observed_cancel_session(false);
        let stale = session.handle(request(1, 8, 1, r#"{"name":"cancel"}"#));
        assert!(matches!(
            stale.response,
            AuthControlResponse::Error {
                code: AuthControlErrorCode::StaleContext,
                ..
            }
        ));
        assert!(matches!(stale.action, AuthControlAction::None));
        assert_eq!(cancel_calls.load(Ordering::SeqCst), 0);

        let pending = session.handle(request(2, 9, 1, r#"{"name":"respond","response":"wrong"}"#));
        assert!(matches!(
            pending.response,
            AuthControlResponse::Challenge { .. }
        ));

        let duplicate = session.handle(request(2, 9, 1, r#"{"name":"cancel"}"#));
        assert!(matches!(
            duplicate.response,
            AuthControlResponse::Error {
                code: AuthControlErrorCode::DuplicateRequest,
                ..
            }
        ));
        assert!(matches!(duplicate.action, AuthControlAction::None));
        assert_eq!(cancel_calls.load(Ordering::SeqCst), 0);

        let valid = session.handle(request(3, 9, 1, r#"{"name":"cancel"}"#));
        assert!(matches!(
            valid.response,
            AuthControlResponse::Cancelled { .. }
        ));
        assert!(matches!(valid.action, AuthControlAction::Cancelled));
        assert_eq!(cancel_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn valid_cancel_is_terminal_exactly_once_even_when_provider_cleanup_fails() {
        for fail_cancel in [false, true] {
            let (mut session, cancel_calls) = observed_cancel_session(fail_cancel);
            let cancelled = session.handle(request(1, 9, 1, r#"{"name":"cancel"}"#));
            if fail_cancel {
                assert!(matches!(
                    cancelled.response,
                    AuthControlResponse::Error {
                        code: AuthControlErrorCode::ProviderFailure,
                        ..
                    }
                ));
            } else {
                assert!(matches!(
                    cancelled.response,
                    AuthControlResponse::Cancelled { .. }
                ));
            }
            assert!(matches!(cancelled.action, AuthControlAction::Cancelled));
            assert_eq!(cancel_calls.load(Ordering::SeqCst), 1);

            let after_cancel =
                session.handle(request(2, 9, 1, r#"{"name":"respond","response":"late"}"#));
            assert!(matches!(
                after_cancel.response,
                AuthControlResponse::Error {
                    code: AuthControlErrorCode::TransactionClosed,
                    ..
                }
            ));
            assert!(matches!(after_cancel.action, AuthControlAction::None));
            assert_eq!(cancel_calls.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn serialized_cancel_wins_over_late_respond_and_resend_commands() {
        let (mut session, cancel_calls) = observed_cancel_session(false);
        let resent = session.handle(request(1, 9, 1, r#"{"name":"resend"}"#));
        assert!(matches!(
            resent.response,
            AuthControlResponse::Challenge { .. }
        ));
        let cancelled = session.handle(request(2, 9, 2, r#"{"name":"cancel"}"#));
        assert!(matches!(cancelled.action, AuthControlAction::Cancelled));

        for (request_id, command) in [
            (3, r#"{"name":"respond","response":"late"}"#),
            (4, r#"{"name":"resend"}"#),
        ] {
            let late = session.handle(request(request_id, 9, 2, command));
            assert!(matches!(
                late.response,
                AuthControlResponse::Error {
                    code: AuthControlErrorCode::TransactionClosed,
                    ..
                }
            ));
        }
        assert_eq!(cancel_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn engine_deadline_poll_terminates_an_idle_transaction_exactly_once() {
        for fail_cancel in [false, true] {
            let id = TransactionId::from_bytes([4; 16]);
            let view = ChallengeView::new(&id, 1, ChallengeKind::Otp).unwrap();
            let cancel_calls = Arc::new(AtomicUsize::new(0));
            let monotonic = Arc::new(AtomicU64::new(100));
            let clock = Arc::clone(&monotonic);
            let owner = AuthTransactionOwner::new_with_clocks_and_policy(
                9,
                ObservedCancelTransaction {
                    view,
                    cancel_calls: Arc::clone(&cancel_calls),
                    fail_cancel,
                },
                || 1_000,
                move || clock.load(Ordering::SeqCst),
                AuthBudgetPolicy::new(5, 2, 2, 1, 4).unwrap(),
            )
            .unwrap();
            let mut session = AuthControlSession::new(owner);
            assert_eq!(
                session.remaining_lifetime().unwrap(),
                std::time::Duration::from_millis(5)
            );
            assert!(!session.expire_if_due().unwrap());
            monotonic.store(105, Ordering::SeqCst);
            let expired = session.expire_if_due();
            if fail_cancel {
                assert!(expired.is_err());
            } else {
                assert!(expired.unwrap());
            }
            assert_eq!(cancel_calls.load(Ordering::SeqCst), 1);
            assert_eq!(
                session.initial_event().unwrap_err().kind(),
                ErrorKind::Lifecycle
            );
        }
    }

    #[test]
    fn budget_exhaustion_is_a_stable_terminal_control_error() {
        let id = TransactionId::from_bytes([4; 16]);
        let view = ChallengeView::new(&id, 1, ChallengeKind::Otp).unwrap();
        let cancel_calls = Arc::new(AtomicUsize::new(0));
        let owner = AuthTransactionOwner::new_with_clocks_and_policy(
            9,
            ObservedCancelTransaction {
                view,
                cancel_calls: Arc::clone(&cancel_calls),
                fail_cancel: false,
            },
            || 1_000,
            || 100,
            AuthBudgetPolicy::new(1_000, 3, 1, 1, 4).unwrap(),
        )
        .unwrap();
        let mut session = AuthControlSession::new(owner);
        let first = session.handle(request(1, 9, 1, r#"{"name":"respond","response":"wrong"}"#));
        assert!(matches!(
            first.response,
            AuthControlResponse::Challenge { .. }
        ));
        let exhausted =
            session.handle(request(2, 9, 1, r#"{"name":"respond","response":"wrong"}"#));
        assert!(matches!(
            exhausted.response,
            AuthControlResponse::Error {
                code: AuthControlErrorCode::LimitExceeded,
                ..
            }
        ));
        assert_eq!(cancel_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            session.initial_event().unwrap_err().kind(),
            ErrorKind::Lifecycle
        );
    }

    #[tokio::test]
    async fn engine_deadline_timer_expires_without_a_renderer_command() {
        let id = TransactionId::from_bytes([4; 16]);
        let view = ChallengeView::new(&id, 1, ChallengeKind::Otp).unwrap();
        let cancel_calls = Arc::new(AtomicUsize::new(0));
        let started = std::time::Instant::now();
        let owner = AuthTransactionOwner::new_with_clocks_and_policy(
            9,
            ObservedCancelTransaction {
                view,
                cancel_calls: Arc::clone(&cancel_calls),
                fail_cancel: false,
            },
            || 1_000,
            move || started.elapsed().as_millis() as u64,
            AuthBudgetPolicy::new(20, 2, 2, 1, 4).unwrap(),
        )
        .unwrap();
        let mut session = AuthControlSession::new(owner);
        session.wait_for_deadline().await.unwrap();
        while !session.remaining_lifetime().unwrap().is_zero() {
            tokio::task::yield_now().await;
        }
        assert!(session.expire_if_due().unwrap());
        assert_eq!(cancel_calls.load(Ordering::SeqCst), 1);
    }
}
