//! Binary-private phase ordering and generation-bound event output.
//! Provider transactions and cleanup remain outside this presentation owner.
use ec_compat::engine::auth_control::{
    AuthControlErrorCode, AuthControlRequest, auth_error_response,
};
use ec_compat::engine::control::ControlExchange;
use ec_compat::engine::event::{EngineEvent, EngineEventEmitter, EngineState, StopReason};
use ec_compat::{Error, ErrorKind, Result};
use std::io::Write;

pub(super) struct EngineLifecycle<W> {
    events: EngineEventEmitter<W>,
    generation: u64,
    phase: Option<EngineState>,
}

impl<W: Write> EngineLifecycle<W> {
    pub(super) fn new(writer: W, generation: u64) -> Self {
        Self {
            events: EngineEventEmitter::new(writer),
            generation,
            phase: None,
        }
    }

    pub(super) fn emit(&mut self, event: EngineEvent) -> Result<()> {
        self.events.emit(&event)
    }

    pub(super) fn emit_control(&mut self, exchange: &ControlExchange) -> Result<()> {
        self.events.emit_control(&exchange.response)
    }

    pub(super) fn reject_auth_control(&mut self, request: &AuthControlRequest) -> Result<()> {
        self.events.emit_auth_control(&auth_error_response(
            request.request_id(),
            AuthControlErrorCode::TransactionClosed,
        ))
    }

    pub(super) fn state(&mut self, state: EngineState) -> Result<()> {
        let allowed = matches!(
            (self.phase, state),
            (None, EngineState::Connecting | EngineState::Stopping)
                | (
                    Some(EngineState::Connecting),
                    EngineState::Authenticating | EngineState::Stopping
                )
                | (
                    Some(EngineState::Authenticating),
                    EngineState::PreparingTunnel | EngineState::Stopping
                )
                | (
                    Some(EngineState::PreparingTunnel),
                    EngineState::Connected | EngineState::Stopping
                )
                | (Some(EngineState::Connected), EngineState::Stopping)
                | (Some(EngineState::Stopping), EngineState::Stopped)
        );
        if !allowed {
            return Err(Error::classified(
                ErrorKind::Lifecycle,
                "invalid engine lifecycle transition",
            ));
        }
        self.phase = Some(state);
        self.emit(EngineEvent::StateChanged {
            state,
            generation: self.generation,
        })
    }

    pub(super) fn begin_stopping(&mut self) -> Result<()> {
        if matches!(
            self.phase,
            Some(EngineState::Stopping | EngineState::Stopped)
        ) {
            return Ok(());
        }
        self.state(EngineState::Stopping)
    }

    pub(super) fn finish(&mut self, reason: StopReason) -> Result<()> {
        self.begin_stopping()?;
        self.state(EngineState::Stopped)?;
        self.emit(EngineEvent::Stopped {
            reason,
            generation: self.generation,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_frames_keep_the_generation_and_are_not_duplicated() {
        let mut output = Vec::new();
        {
            let mut lifecycle = EngineLifecycle::new(&mut output, u64::MAX);
            lifecycle.state(EngineState::Connecting).unwrap();
            lifecycle.finish(StopReason::StartupFailed).unwrap();
            assert!(lifecycle.finish(StopReason::StartupFailed).is_err());
        }
        let frames: Vec<serde_json::Value> = output
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        assert_eq!(
            frames,
            vec![
                serde_json::json!({"type": "state_changed", "state": "connecting", "generation": u64::MAX}),
                serde_json::json!({"type": "state_changed", "state": "stopping", "generation": u64::MAX}),
                serde_json::json!({"type": "state_changed", "state": "stopped", "generation": u64::MAX}),
                serde_json::json!({"type": "stopped", "reason": "startup_failed", "generation": u64::MAX}),
            ]
        );
    }

    #[test]
    fn engine_lifecycle_accepts_only_the_reviewed_phase_order() {
        let mut lifecycle = EngineLifecycle::new(Vec::new(), 17);
        assert!(lifecycle.state(EngineState::Authenticating).is_err());
        lifecycle.state(EngineState::Connecting).unwrap();
        assert!(lifecycle.state(EngineState::Connected).is_err());
        lifecycle.state(EngineState::Authenticating).unwrap();
        lifecycle.state(EngineState::PreparingTunnel).unwrap();
        lifecycle.state(EngineState::Connected).unwrap();
        assert!(lifecycle.state(EngineState::Authenticating).is_err());
        lifecycle.begin_stopping().unwrap();
        lifecycle.begin_stopping().unwrap();
        lifecycle.finish(StopReason::UserRequested).unwrap();
        assert!(lifecycle.finish(StopReason::UserRequested).is_err());
    }
}
