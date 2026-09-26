//! Engine-owned interactive authentication transaction contracts.
//!
//! These types intentionally describe no vendor endpoint, form field, OTP
//! length, or delivery-method mapping. Gateway cookies, CSRF material, TwfID,
//! and opaque continuation state belong inside an [`AuthTransaction`]
//! implementation; only [`ChallengeView`] is safe to serialize outside Rust.

use crate::{Error, ErrorKind, Result};
use rand::Rng;
use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;
use serde::Serialize;
use std::collections::{BTreeSet, VecDeque};
use std::fmt::{Debug, Formatter};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

pub const MAX_AUTH_RESPONSE_BYTES: usize = 4096;
pub const MAX_MASKED_DESTINATION_BYTES: usize = 128;
pub const MAX_TRACKED_AUTH_REQUEST_IDS: usize = 64;
pub const AUTH_TRANSACTION_TIMEOUT_MS: u64 = 4 * 60 * 1_000;
pub const MAX_AUTH_CHALLENGE_STEPS: u32 = 10;
pub const MAX_AUTH_SUBMITS: u32 = 6;
pub const MAX_AUTH_RESENDS: u32 = 4;
pub const MAX_AUTH_GATEWAY_REQUESTS: u32 = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AuthBudgetPolicy {
    total_timeout_ms: u64,
    max_challenge_steps: u32,
    max_submits: u32,
    max_resends: u32,
    max_gateway_requests: u32,
}

impl AuthBudgetPolicy {
    pub const PRODUCTION: Self = Self {
        total_timeout_ms: AUTH_TRANSACTION_TIMEOUT_MS,
        max_challenge_steps: MAX_AUTH_CHALLENGE_STEPS,
        max_submits: MAX_AUTH_SUBMITS,
        max_resends: MAX_AUTH_RESENDS,
        max_gateway_requests: MAX_AUTH_GATEWAY_REQUESTS,
    };

    pub fn new(
        total_timeout_ms: u64,
        max_challenge_steps: u32,
        max_submits: u32,
        max_resends: u32,
        max_gateway_requests: u32,
    ) -> Result<Self> {
        if total_timeout_ms == 0
            || max_challenge_steps == 0
            || max_submits == 0
            || max_resends == 0
            || max_gateway_requests == 0
            || total_timeout_ms > AUTH_TRANSACTION_TIMEOUT_MS
            || max_challenge_steps > MAX_AUTH_CHALLENGE_STEPS
            || max_submits > MAX_AUTH_SUBMITS
            || max_resends > MAX_AUTH_RESENDS
            || max_gateway_requests > MAX_AUTH_GATEWAY_REQUESTS
        {
            return Err(transaction_error("authentication budget is invalid"));
        }
        Ok(Self {
            total_timeout_ms,
            max_challenge_steps,
            max_submits,
            max_resends,
            max_gateway_requests,
        })
    }
}

struct AuthBudget {
    policy: AuthBudgetPolicy,
    deadline_monotonic_ms: u64,
    challenge_steps: u32,
    submits: u32,
    resends: u32,
    gateway_requests: u32,
}

impl AuthBudget {
    fn new(started_monotonic_ms: u64, policy: AuthBudgetPolicy) -> Self {
        Self {
            policy,
            deadline_monotonic_ms: started_monotonic_ms.saturating_add(policy.total_timeout_ms),
            challenge_steps: 1,
            submits: 0,
            resends: 0,
            gateway_requests: 0,
        }
    }

    fn ensure_active(&self, now_monotonic_ms: u64) -> Result<()> {
        if now_monotonic_ms >= self.deadline_monotonic_ms {
            return Err(Error::classified(
                ErrorKind::AuthenticationExpired,
                "authentication transaction has expired",
            ));
        }
        Ok(())
    }

    fn reserve_submit(&mut self, now_monotonic_ms: u64) -> Result<()> {
        self.ensure_active(now_monotonic_ms)?;
        if self.submits >= self.policy.max_submits {
            return Err(authentication_limit("authentication submit limit reached"));
        }
        self.submits += 1;
        Ok(())
    }

    fn reserve_resend(&mut self, now_monotonic_ms: u64) -> Result<()> {
        self.ensure_active(now_monotonic_ms)?;
        if self.resends >= self.policy.max_resends {
            return Err(authentication_limit("authentication resend limit reached"));
        }
        if self.challenge_steps >= self.policy.max_challenge_steps {
            return Err(authentication_limit("authentication step limit reached"));
        }
        self.resends += 1;
        Ok(())
    }

    fn reserve_gateway_request(&mut self, now_monotonic_ms: u64) -> Result<()> {
        self.ensure_active(now_monotonic_ms)?;
        if self.gateway_requests >= self.policy.max_gateway_requests {
            return Err(authentication_limit(
                "authentication gateway request limit reached",
            ));
        }
        self.gateway_requests += 1;
        Ok(())
    }

    fn accept_challenge_step(&mut self, is_new_step: bool) -> Result<()> {
        if !is_new_step {
            return Ok(());
        }
        if self.challenge_steps >= self.policy.max_challenge_steps {
            return Err(authentication_limit("authentication step limit reached"));
        }
        self.challenge_steps += 1;
        Ok(())
    }

    fn remaining_ms(&self, now_monotonic_ms: u64) -> u64 {
        self.deadline_monotonic_ms.saturating_sub(now_monotonic_ms)
    }
}

pub struct AuthGatewayRequestBudget<'a> {
    budget: &'a mut AuthBudget,
    now_monotonic_ms: &'a (dyn Fn() -> u64 + Send + Sync),
}

impl AuthGatewayRequestBudget<'_> {
    /// Must be called immediately before each continuation HTTP request.
    pub fn reserve_request(&mut self) -> Result<()> {
        self.budget
            .reserve_gateway_request((self.now_monotonic_ms)())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChallengeKind {
    Captcha,
    Otp,
    Token,
    Approval,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryChannel {
    Sms,
    Email,
    Authenticator,
    Device,
    Unknown,
}

#[derive(Clone, Eq, PartialEq)]
pub struct TransactionId([u8; 16]);

impl TransactionId {
    pub fn generate() -> Self {
        let mut bytes = [0_u8; 16];
        UnwrapErr(SysRng).fill_bytes(&mut bytes);
        Self(bytes)
    }

    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    pub fn public_id(&self) -> String {
        hex::encode(self.0)
    }
}

impl Debug for TransactionId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("TransactionId(<engine-correlation>)")
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeView {
    transaction_id: String,
    challenge_epoch: u32,
    kind: ChallengeKind,
    delivery_channel: Option<DeliveryChannel>,
    masked_destination: Option<String>,
    expires_at_unix_ms: Option<u64>,
    resend_available: bool,
    resend_after_unix_ms: Option<u64>,
    attempts_remaining: Option<u32>,
}

impl ChallengeView {
    pub fn new(
        transaction_id: &TransactionId,
        challenge_epoch: u32,
        kind: ChallengeKind,
    ) -> Result<Self> {
        if challenge_epoch == 0 {
            return Err(transaction_error("challenge epoch must be nonzero"));
        }
        Ok(Self {
            transaction_id: transaction_id.public_id(),
            challenge_epoch,
            kind,
            delivery_channel: None,
            masked_destination: None,
            expires_at_unix_ms: None,
            resend_available: false,
            resend_after_unix_ms: None,
            attempts_remaining: None,
        })
    }

    pub fn with_delivery(
        mut self,
        channel: DeliveryChannel,
        masked_destination: Option<&str>,
    ) -> Result<Self> {
        self.delivery_channel = Some(channel);
        self.masked_destination = masked_destination
            .map(validate_masked_destination)
            .transpose()?;
        Ok(self)
    }

    pub const fn with_expiry(mut self, expires_at_unix_ms: Option<u64>) -> Self {
        self.expires_at_unix_ms = expires_at_unix_ms;
        self
    }

    pub const fn with_resend(mut self, available: bool, resend_after_unix_ms: Option<u64>) -> Self {
        self.resend_available = available;
        self.resend_after_unix_ms = if available {
            resend_after_unix_ms
        } else {
            None
        };
        self
    }

    pub const fn with_attempts_remaining(mut self, attempts: Option<u32>) -> Self {
        self.attempts_remaining = attempts;
        self
    }

    pub fn transaction_id(&self) -> &str {
        &self.transaction_id
    }

    pub const fn challenge_epoch(&self) -> u32 {
        self.challenge_epoch
    }

    pub const fn kind(&self) -> ChallengeKind {
        self.kind
    }

    pub const fn resend_available(&self) -> bool {
        self.resend_available
    }

    pub const fn resend_after_unix_ms(&self) -> Option<u64> {
        self.resend_after_unix_ms
    }

    pub const fn expires_at_unix_ms(&self) -> Option<u64> {
        self.expires_at_unix_ms
    }
}

impl Debug for ChallengeView {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ChallengeView")
            .field("transaction_id", &"<engine-correlation>")
            .field("challenge_epoch", &self.challenge_epoch)
            .field("kind", &self.kind)
            .field("delivery_channel", &self.delivery_channel)
            .field(
                "masked_destination",
                &self.masked_destination.as_ref().map(|_| "<redacted>"),
            )
            .field("expires_at_unix_ms", &self.expires_at_unix_ms)
            .field("resend_available", &self.resend_available)
            .field("resend_after_unix_ms", &self.resend_after_unix_ms)
            .field("attempts_remaining", &self.attempts_remaining)
            .finish()
    }
}

pub struct SecretBytes(Zeroizing<Vec<u8>>);

impl SecretBytes {
    pub fn new(value: &[u8]) -> Result<Self> {
        if value.is_empty() || value.len() > MAX_AUTH_RESPONSE_BYTES {
            return Err(transaction_error(
                "authentication response has an invalid length",
            ));
        }
        Ok(Self(Zeroizing::new(value.to_vec())))
    }

    pub fn as_bytes(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl Debug for SecretBytes {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SecretBytes(<redacted>)")
    }
}

#[derive(Debug)]
pub enum AuthProgress<S, T> {
    Authenticated(S),
    ChallengeRequired(T),
}

pub trait AuthTransaction: Send {
    type Session;

    fn public_challenge(&self) -> ChallengeView;
    fn respond(
        &mut self,
        response: SecretBytes,
        gateway_requests: &mut AuthGatewayRequestBudget<'_>,
    ) -> Result<AuthProgress<Self::Session, ChallengeView>>;
    fn resend(
        &mut self,
        gateway_requests: &mut AuthGatewayRequestBudget<'_>,
    ) -> Result<ChallengeView>;
    fn cancel(self) -> Result<()>;
}

pub struct AuthTransactionOwner<T: AuthTransaction> {
    generation: u64,
    transaction: Option<T>,
    current_view: ChallengeView,
    recent_request_ids: BTreeSet<u64>,
    request_order: VecDeque<u64>,
    now_unix_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    now_monotonic_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    budget: AuthBudget,
}

impl<T: AuthTransaction> Drop for AuthTransactionOwner<T> {
    fn drop(&mut self) {
        if let Some(transaction) = self.transaction.take() {
            let _ = transaction.cancel();
        }
    }
}

impl<T: AuthTransaction> AuthTransactionOwner<T> {
    pub fn new(generation: u64, transaction: T) -> Result<Self> {
        Self::new_with_clocks_and_policy(
            generation,
            transaction,
            system_unix_ms,
            system_monotonic_ms,
            AuthBudgetPolicy::PRODUCTION,
        )
    }

    pub fn new_with_clock<F>(generation: u64, transaction: T, now_unix_ms: F) -> Result<Self>
    where
        F: Fn() -> u64 + Send + Sync + 'static,
    {
        Self::new_with_clocks_and_policy(
            generation,
            transaction,
            now_unix_ms,
            system_monotonic_ms,
            AuthBudgetPolicy::PRODUCTION,
        )
    }

    pub fn new_with_clocks_and_policy<FW, FM>(
        generation: u64,
        transaction: T,
        now_unix_ms: FW,
        now_monotonic_ms: FM,
        policy: AuthBudgetPolicy,
    ) -> Result<Self>
    where
        FW: Fn() -> u64 + Send + Sync + 'static,
        FM: Fn() -> u64 + Send + Sync + 'static,
    {
        if generation == 0 {
            return Err(transaction_error("auth generation must be nonzero"));
        }
        let current_view = transaction.public_challenge();
        if current_view.challenge_epoch() == 0 {
            return Err(transaction_error("challenge epoch must be nonzero"));
        }
        let now_monotonic_ms: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(now_monotonic_ms);
        let budget = AuthBudget::new(now_monotonic_ms(), policy);
        let owner = Self {
            generation,
            transaction: Some(transaction),
            current_view,
            recent_request_ids: BTreeSet::new(),
            request_order: VecDeque::new(),
            now_unix_ms: Arc::new(now_unix_ms),
            now_monotonic_ms,
            budget,
        };
        owner.ensure_not_expired()?;
        Ok(owner)
    }

    pub fn public_challenge(&self) -> &ChallengeView {
        &self.current_view
    }

    pub const fn is_active(&self) -> bool {
        self.transaction.is_some()
    }

    pub fn respond(
        &mut self,
        context: AuthCommandContext<'_>,
        response: SecretBytes,
    ) -> Result<AuthProgress<T::Session, ChallengeView>> {
        self.validate_context(context, true)?;
        if self.current_view.kind() == ChallengeKind::Unknown {
            return Err(Error::classified(
                ErrorKind::UnsupportedCapability,
                "unknown authentication challenge is unsupported",
            ));
        }
        self.remember_request(context.request_id)?;
        self.budget.reserve_submit((self.now_monotonic_ms)())?;
        let previous_epoch = self.current_view.challenge_epoch();
        let mut gateway_requests = AuthGatewayRequestBudget {
            budget: &mut self.budget,
            now_monotonic_ms: self.now_monotonic_ms.as_ref(),
        };
        let progress = self
            .transaction
            .as_mut()
            .ok_or_else(|| transaction_error("auth transaction is no longer active"))?
            .respond(response, &mut gateway_requests)?;
        match progress {
            AuthProgress::Authenticated(session) => {
                self.transaction.take();
                Ok(AuthProgress::Authenticated(session))
            }
            AuthProgress::ChallengeRequired(view) => {
                if let Err(error) = self
                    .budget
                    .accept_challenge_step(view.challenge_epoch() > previous_epoch)
                {
                    self.cancel_invalid_transition();
                    return Err(error);
                }
                self.accept_updated_view(view.clone(), false)?;
                Ok(AuthProgress::ChallengeRequired(view))
            }
        }
    }

    pub fn resend(&mut self, context: AuthCommandContext<'_>) -> Result<ChallengeView> {
        self.validate_context(context, true)?;
        if self.current_view.kind() == ChallengeKind::Unknown {
            return Err(Error::classified(
                ErrorKind::UnsupportedCapability,
                "unknown authentication challenge is unsupported",
            ));
        }
        if !self.current_view.resend_available() {
            return Err(Error::classified(
                ErrorKind::ResendUnavailable,
                "challenge resend is unavailable",
            ));
        }
        if self
            .current_view
            .resend_after_unix_ms()
            .is_some_and(|not_before| (self.now_unix_ms)() < not_before)
        {
            return Err(Error::classified(
                ErrorKind::ResendUnavailable,
                "challenge resend cooldown is active",
            ));
        }
        self.remember_request(context.request_id)?;
        self.budget.reserve_resend((self.now_monotonic_ms)())?;
        let mut gateway_requests = AuthGatewayRequestBudget {
            budget: &mut self.budget,
            now_monotonic_ms: self.now_monotonic_ms.as_ref(),
        };
        let view = self
            .transaction
            .as_mut()
            .ok_or_else(|| transaction_error("auth transaction is no longer active"))?
            .resend(&mut gateway_requests)?;
        if let Err(error) = self.budget.accept_challenge_step(true) {
            self.cancel_invalid_transition();
            return Err(error);
        }
        self.accept_updated_view(view.clone(), true)?;
        Ok(view)
    }

    pub fn cancel(&mut self, context: AuthCommandContext<'_>) -> Result<()> {
        self.validate_context(context, false)?;
        self.remember_request(context.request_id)?;
        self.transaction
            .take()
            .ok_or_else(|| transaction_error("auth transaction is no longer active"))?
            .cancel()
    }

    /// Engine-internal terminal cleanup for expiry, process shutdown, or a
    /// control-channel failure. It does not require an untrusted client context.
    pub fn abort(mut self) -> Result<()> {
        self.transaction
            .take()
            .ok_or_else(|| {
                Error::classified(ErrorKind::Lifecycle, "auth transaction is no longer active")
            })?
            .cancel()
    }

    pub fn remaining_lifetime(&self) -> Result<Duration> {
        if self.transaction.is_none() {
            return Err(Error::classified(
                ErrorKind::Lifecycle,
                "auth transaction is no longer active",
            ));
        }
        let total = self.budget.remaining_ms((self.now_monotonic_ms)());
        let challenge = self
            .current_view
            .expires_at_unix_ms()
            .map(|expires_at| expires_at.saturating_sub((self.now_unix_ms)()))
            .unwrap_or(u64::MAX);
        Ok(Duration::from_millis(total.min(challenge)))
    }

    pub fn expire_if_due(&mut self) -> Result<bool> {
        if !self.remaining_lifetime()?.is_zero() {
            return Ok(false);
        }
        let cleanup = self
            .transaction
            .take()
            .ok_or_else(|| transaction_error("auth transaction is no longer active"))?
            .cancel();
        cleanup.map(|_| true)
    }

    fn validate_context(
        &self,
        context: AuthCommandContext<'_>,
        require_unexpired: bool,
    ) -> Result<()> {
        if context.request_id == 0
            || context.generation != self.generation
            || context.transaction_id != self.current_view.transaction_id()
            || context.challenge_epoch != self.current_view.challenge_epoch()
        {
            return Err(Error::classified(
                ErrorKind::AuthenticationStaleContext,
                "auth command context is stale or invalid",
            ));
        }
        if self.recent_request_ids.contains(&context.request_id) {
            return Err(Error::classified(
                ErrorKind::DuplicateRequest,
                "duplicate auth request id",
            ));
        }
        if self.transaction.is_none() {
            return Err(Error::classified(
                ErrorKind::Lifecycle,
                "auth transaction is no longer active",
            ));
        }
        if require_unexpired {
            self.ensure_not_expired()?;
        }
        Ok(())
    }

    fn ensure_not_expired(&self) -> Result<()> {
        self.budget.ensure_active((self.now_monotonic_ms)())?;
        if self
            .current_view
            .expires_at_unix_ms()
            .is_some_and(|expires_at| (self.now_unix_ms)() >= expires_at)
        {
            return Err(Error::classified(
                ErrorKind::AuthenticationExpired,
                "authentication challenge has expired",
            ));
        }
        Ok(())
    }

    fn remember_request(&mut self, request_id: u64) -> Result<()> {
        if self.recent_request_ids.contains(&request_id) {
            return Err(Error::classified(
                ErrorKind::DuplicateRequest,
                "duplicate auth request id",
            ));
        }
        if self.request_order.len() == MAX_TRACKED_AUTH_REQUEST_IDS
            && let Some(expired) = self.request_order.pop_front()
        {
            self.recent_request_ids.remove(&expired);
        }
        self.request_order.push_back(request_id);
        self.recent_request_ids.insert(request_id);
        Ok(())
    }

    fn accept_updated_view(&mut self, view: ChallengeView, require_new_epoch: bool) -> Result<()> {
        let same_transaction = view.transaction_id() == self.current_view.transaction_id();
        let epoch_valid = if require_new_epoch {
            view.challenge_epoch() > self.current_view.challenge_epoch()
        } else {
            view.challenge_epoch() >= self.current_view.challenge_epoch()
        };
        if !same_transaction || !epoch_valid {
            self.cancel_invalid_transition();
            return Err(transaction_error(
                "auth provider returned an invalid challenge transition",
            ));
        }
        let provider_view = self
            .transaction
            .as_ref()
            .ok_or_else(|| transaction_error("auth transaction is no longer active"))?
            .public_challenge();
        if provider_view != view {
            self.cancel_invalid_transition();
            return Err(transaction_error(
                "auth provider challenge view is inconsistent",
            ));
        }
        self.current_view = view;
        Ok(())
    }

    fn cancel_invalid_transition(&mut self) {
        if let Some(transaction) = self.transaction.take() {
            let _ = transaction.cancel();
        }
    }
}

#[derive(Clone, Copy)]
pub struct AuthCommandContext<'a> {
    pub generation: u64,
    pub transaction_id: &'a str,
    pub challenge_epoch: u32,
    pub request_id: u64,
}

fn validate_masked_destination(value: &str) -> Result<String> {
    if value.is_empty()
        || value.len() > MAX_MASKED_DESTINATION_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(transaction_error(
            "masked challenge destination has an invalid shape",
        ));
    }
    Ok(value.to_owned())
}

fn transaction_error(message: impl Into<String>) -> Error {
    Error::classified(ErrorKind::Authentication, message)
}

fn authentication_limit(message: impl Into<String>) -> Error {
    Error::classified(ErrorKind::AuthenticationLimitExceeded, message)
}

fn system_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(u64::MAX)
}

fn system_monotonic_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn public_view_is_bounded_serializable_and_debug_redacted() {
        let id = TransactionId::from_bytes([7; 16]);
        let view = ChallengeView::new(&id, 1, ChallengeKind::Otp)
            .unwrap()
            .with_delivery(DeliveryChannel::Email, Some("s***@example.test"))
            .unwrap()
            .with_expiry(Some(1_800_000_000_000))
            .with_resend(true, Some(1_799_999_999_000))
            .with_attempts_remaining(Some(3));
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["transactionId"], id.public_id());
        assert_eq!(json["challengeEpoch"], 1);
        assert_eq!(json["kind"], "otp");
        assert_eq!(json["deliveryChannel"], "email");
        assert_eq!(json["maskedDestination"], "s***@example.test");
        assert!(!format!("{view:?}").contains("s***@example.test"));
    }

    #[test]
    fn response_secret_is_only_length_bounded_and_never_debugged() {
        let binary = SecretBytes::new(&[0, 1, 2, 255]).unwrap();
        assert_eq!(binary.as_bytes(), [0, 1, 2, 255]);
        assert_eq!(format!("{binary:?}"), "SecretBytes(<redacted>)");
        assert!(SecretBytes::new(&[]).is_err());
        assert!(SecretBytes::new(&vec![0; MAX_AUTH_RESPONSE_BYTES + 1]).is_err());
    }

    #[test]
    fn authentication_budget_policy_can_only_tighten_production_ceilings() {
        assert_eq!(
            AuthBudgetPolicy::new(
                AUTH_TRANSACTION_TIMEOUT_MS,
                MAX_AUTH_CHALLENGE_STEPS,
                MAX_AUTH_SUBMITS,
                MAX_AUTH_RESENDS,
                MAX_AUTH_GATEWAY_REQUESTS,
            )
            .unwrap(),
            AuthBudgetPolicy::PRODUCTION
        );
        assert!(AuthBudgetPolicy::new(0, 1, 1, 1, 1).is_err());
        assert!(
            AuthBudgetPolicy::new(
                AUTH_TRANSACTION_TIMEOUT_MS + 1,
                MAX_AUTH_CHALLENGE_STEPS,
                MAX_AUTH_SUBMITS,
                MAX_AUTH_RESENDS,
                MAX_AUTH_GATEWAY_REQUESTS,
            )
            .is_err()
        );
    }

    #[test]
    fn unknown_challenge_is_not_respondable_by_construction() {
        struct UnknownTransaction {
            view: ChallengeView,
        }
        impl AuthTransaction for UnknownTransaction {
            type Session = ();
            fn public_challenge(&self) -> ChallengeView {
                self.view.clone()
            }
            fn respond(
                &mut self,
                _response: SecretBytes,
                _gateway_requests: &mut AuthGatewayRequestBudget<'_>,
            ) -> Result<AuthProgress<Self::Session, ChallengeView>> {
                panic!("owner must reject unknown challenge before provider call")
            }
            fn resend(
                &mut self,
                _gateway_requests: &mut AuthGatewayRequestBudget<'_>,
            ) -> Result<ChallengeView> {
                panic!("owner must reject unknown challenge before provider call")
            }
            fn cancel(self) -> Result<()> {
                Ok(())
            }
        }
        let id = TransactionId::from_bytes([9; 16]);
        let transaction = UnknownTransaction {
            view: ChallengeView::new(&id, 1, ChallengeKind::Unknown).unwrap(),
        };
        let mut owner = AuthTransactionOwner::new(7, transaction).unwrap();
        let view = owner.public_challenge().clone();
        let context = AuthCommandContext {
            generation: 7,
            transaction_id: view.transaction_id(),
            challenge_epoch: 1,
            request_id: 1,
        };
        let error = owner
            .respond(context, SecretBytes::new(b"not-used").unwrap())
            .err()
            .unwrap();
        assert_eq!(error.kind(), ErrorKind::UnsupportedCapability);
        assert!(owner.is_active());
    }

    #[test]
    fn dropping_an_active_owner_invokes_provider_cleanup() {
        struct CleanupTransaction {
            view: ChallengeView,
            cancelled: Arc<AtomicBool>,
        }
        impl AuthTransaction for CleanupTransaction {
            type Session = ();
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
                Ok(self.view.clone())
            }
            fn cancel(self) -> Result<()> {
                self.cancelled.store(true, Ordering::SeqCst);
                Ok(())
            }
        }

        let cancelled = Arc::new(AtomicBool::new(false));
        let view =
            ChallengeView::new(&TransactionId::from_bytes([3; 16]), 1, ChallengeKind::Otp).unwrap();
        let owner = AuthTransactionOwner::new(
            2,
            CleanupTransaction {
                view,
                cancelled: Arc::clone(&cancelled),
            },
        )
        .unwrap();
        drop(owner);
        assert!(cancelled.load(Ordering::SeqCst));
    }
}
