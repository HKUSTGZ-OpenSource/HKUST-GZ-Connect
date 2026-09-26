//! Binary-private inherited control pipe and pending shutdown ownership.
//! The process coordinator retains phase-specific EOF and teardown policy.
use ec_compat::engine::auth_control::AuthControlRequest;
use ec_compat::engine::control::{
    ControlAction, ControlExchange, ControlSession, MAX_ACTIVE_REQUESTS,
};
use ec_compat::engine::control_mux::{InheritedControlFrameReader, InheritedControlRequest};
use ec_compat::engine::provider::ProviderCapabilityReport;
use ec_compat::{Error, Result};
use std::time::Duration;

const CONTROL_SHUTDOWN_CANCEL_WINDOW: Duration = Duration::from_millis(100);

pub(super) enum ControlInput {
    V2(ControlExchange),
    V3(AuthControlRequest),
}

#[derive(Default)]
pub(super) struct PendingControlActions {
    shutdowns: std::collections::BTreeMap<u64, tokio::time::Instant>,
}

#[derive(Clone)]
pub(super) struct ProviderControlContext {
    pub(super) profile_id: String,
    pub(super) profile_revision: u64,
    pub(super) engine_generation: u64,
    pub(super) report: ProviderCapabilityReport,
}

impl PendingControlActions {
    pub(super) fn apply(&mut self, action: ControlAction, now: tokio::time::Instant) -> bool {
        match action {
            ControlAction::Shutdown { request_id } => {
                self.shutdowns
                    .insert(request_id, now + CONTROL_SHUTDOWN_CANCEL_WINDOW);
                false
            }
            ControlAction::Cancel {
                request_to_cancel, ..
            } => {
                self.shutdowns.remove(&request_to_cancel);
                false
            }
            ControlAction::Close { .. } => true,
        }
    }

    pub(super) fn next_shutdown_deadline(&self) -> Option<tokio::time::Instant> {
        self.shutdowns.values().copied().min()
    }
}

pub(super) fn start_control_reader(
    provider_context: Option<ProviderControlContext>,
) -> Result<tokio::sync::mpsc::Receiver<ControlInput>> {
    let (sender, receiver) = tokio::sync::mpsc::channel(MAX_ACTIVE_REQUESTS);
    std::thread::Builder::new()
        .name("ec-engine-control".into())
        .spawn(move || {
            let stdin = std::io::stdin();
            if control_reader_loop(stdin.lock(), sender, provider_context).is_err() {
                // Framing errors are intentionally generic: never echo a raw
                // control line that might have been supplied by a faulty
                // caller. EOF is a normal control-channel close and does not
                // reach this branch or stop the engine.
                eprintln!("ec-engine: invalid engine control frame; control channel closed");
            }
        })
        .map_err(|_| Error("engine control reader could not start".into()))?;
    Ok(receiver)
}

fn control_reader_loop<R: std::io::Read>(
    reader: R,
    sender: tokio::sync::mpsc::Sender<ControlInput>,
    provider_context: Option<ProviderControlContext>,
) -> Result<()> {
    let mut reader = InheritedControlFrameReader::new(reader);
    let mut session = match provider_context {
        Some(context) => ControlSession::with_provider_capabilities(
            context.profile_id,
            context.profile_revision,
            context.engine_generation,
            context.report,
        )?,
        None => ControlSession::new(),
    };
    while let Some(request) = reader.read_request()? {
        let (input, closes_channel) = match request {
            InheritedControlRequest::V2(request) => {
                let exchange = session.handle(request);
                let closes_channel = matches!(exchange.action, Some(ControlAction::Close { .. }));
                (ControlInput::V2(exchange), closes_channel)
            }
            InheritedControlRequest::V3(request) => (ControlInput::V3(request), false),
        };
        if sender.blocking_send(input).is_err() {
            return Ok(());
        }
        if closes_channel {
            return Ok(());
        }
    }
    Ok(())
}

pub(super) async fn receive_control(
    receiver: &mut Option<tokio::sync::mpsc::Receiver<ControlInput>>,
) -> Option<ControlInput> {
    match receiver {
        Some(receiver) => receiver.recv().await,
        None => std::future::pending().await,
    }
}

pub(super) async fn wait_for_control_shutdown(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_close_stops_before_any_trailing_frame() {
        let wire = concat!(
            "{\"type\":\"hello\",\"requestId\":1,\"versions\":[2]}\n",
            "{\"type\":\"close\",\"apiVersion\":2,\"requestId\":2}\n",
            "malformed-private-fixture\n"
        );
        let (sender, mut receiver) = tokio::sync::mpsc::channel(MAX_ACTIVE_REQUESTS);
        control_reader_loop(wire.as_bytes(), sender, None).unwrap();
        assert!(matches!(
            receiver.blocking_recv(),
            Some(ControlInput::V2(_))
        ));
        let Some(ControlInput::V2(close)) = receiver.blocking_recv() else {
            panic!("expected close");
        };
        assert_eq!(close.action, Some(ControlAction::Close { request_id: 2 }));
        assert!(receiver.blocking_recv().is_none());
    }

    #[test]
    fn dropped_receiver_stops_the_reader_without_decoding_further_frames() {
        let wire = concat!(
            "{\"type\":\"hello\",\"requestId\":1,\"versions\":[2]}\n",
            "malformed-private-fixture\n"
        );
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        drop(receiver);
        control_reader_loop(wire.as_bytes(), sender, None).unwrap();
    }

    #[test]
    fn malformed_input_closes_only_the_channel_without_echoing_input() {
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        let error = control_reader_loop(b"malformed-private-fixture\n".as_slice(), sender, None)
            .unwrap_err();
        assert!(!error.to_string().contains("private-fixture"));
        assert!(receiver.blocking_recv().is_none());
    }

    #[test]
    fn cancellation_removes_only_its_request_and_close_preserves_accepted_work() {
        let now = tokio::time::Instant::now();
        let later = now + Duration::from_millis(25);
        let mut pending = PendingControlActions::default();
        pending.apply(ControlAction::Shutdown { request_id: 1 }, now);
        pending.apply(ControlAction::Shutdown { request_id: 2 }, later);
        assert_eq!(
            pending.next_shutdown_deadline(),
            Some(now + CONTROL_SHUTDOWN_CANCEL_WINDOW)
        );
        pending.apply(
            ControlAction::Cancel {
                request_id: 3,
                request_to_cancel: 1,
            },
            later,
        );
        assert_eq!(
            pending.next_shutdown_deadline(),
            Some(later + CONTROL_SHUTDOWN_CANCEL_WINDOW)
        );
        assert!(pending.apply(ControlAction::Close { request_id: 4 }, later));
        assert_eq!(
            pending.next_shutdown_deadline(),
            Some(later + CONTROL_SHUTDOWN_CANCEL_WINDOW)
        );
    }

    #[test]
    fn synthetic_control_reader_preserves_eof_and_typed_actions() {
        let wire = b"{\"type\":\"hello\",\"requestId\":1,\"versions\":[2]}\n{\"type\":\"request\",\"apiVersion\":2,\"requestId\":2,\"command\":{\"name\":\"require_capability\",\"capability\":\"transport.web_vpn\"}}\n{\"type\":\"request\",\"apiVersion\":2,\"requestId\":3,\"command\":{\"name\":\"shutdown\"}}\n{\"type\":\"cancel\",\"apiVersion\":2,\"requestId\":4,\"requestToCancel\":3}\n{\"type\":\"close\",\"apiVersion\":2,\"requestId\":5}\n";
        let (sender, mut receiver) = tokio::sync::mpsc::channel(MAX_ACTIVE_REQUESTS);
        control_reader_loop(wire.as_slice(), sender, None).unwrap();

        let hello = receiver.blocking_recv().unwrap();
        let ControlInput::V2(hello) = hello else {
            panic!("expected v2 hello");
        };
        assert!(matches!(
            hello.response,
            ec_compat::engine::control::ControlResponse::Hello { .. }
        ));
        let unsupported = receiver.blocking_recv().unwrap();
        let ControlInput::V2(unsupported) = unsupported else {
            panic!("expected v2 capability response");
        };
        assert!(matches!(
            unsupported.response,
            ec_compat::engine::control::ControlResponse::Error {
                error: ec_compat::engine::control::ControlProtocolError::UnsupportedCapability {
                    capability: ec_compat::engine::control::ControlCapability::TransportWebVpn,
                },
                ..
            }
        ));
        assert_eq!(unsupported.action, None);
        let shutdown = receiver.blocking_recv().unwrap();
        let ControlInput::V2(shutdown) = shutdown else {
            panic!("expected v2 shutdown");
        };
        assert_eq!(
            shutdown.action,
            Some(ControlAction::Shutdown { request_id: 3 })
        );
        let cancel = receiver.blocking_recv().unwrap();
        let ControlInput::V2(cancel) = cancel else {
            panic!("expected v2 cancel");
        };
        assert_eq!(
            cancel.action,
            Some(ControlAction::Cancel {
                request_id: 4,
                request_to_cancel: 3,
            })
        );
        let close = receiver.blocking_recv().unwrap();
        let ControlInput::V2(close) = close else {
            panic!("expected v2 close");
        };
        assert_eq!(close.action, Some(ControlAction::Close { request_id: 5 }));
        // Reader EOF/close drops only this bounded channel. There is no
        // synthesized Shutdown action.
        assert!(receiver.blocking_recv().is_none());
    }

    #[test]
    fn control_reader_multiplexes_v3_without_changing_v2_session_state() {
        let wire = b"{\"type\":\"auth_request\",\"apiVersion\":3,\"requestId\":7,\"generation\":9,\"transactionId\":\"04040404040404040404040404040404\",\"challengeEpoch\":1,\"command\":{\"name\":\"respond\",\"response\":\"private-fixture\"}}\n{\"type\":\"hello\",\"requestId\":8,\"versions\":[2]}\n{\"type\":\"close\",\"apiVersion\":2,\"requestId\":9}\n";
        let (sender, mut receiver) = tokio::sync::mpsc::channel(MAX_ACTIVE_REQUESTS);
        control_reader_loop(wire.as_slice(), sender, None).unwrap();

        let ControlInput::V3(request) = receiver.blocking_recv().unwrap() else {
            panic!("expected v3 auth request");
        };
        assert_eq!(request.request_id(), 7);
        assert!(!format!("{request:?}").contains("private-fixture"));
        let ControlInput::V2(hello) = receiver.blocking_recv().unwrap() else {
            panic!("expected v2 hello");
        };
        assert!(matches!(
            hello.response,
            ec_compat::engine::control::ControlResponse::Hello { .. }
        ));
        let ControlInput::V2(close) = receiver.blocking_recv().unwrap() else {
            panic!("expected v2 close");
        };
        assert_eq!(close.action, Some(ControlAction::Close { request_id: 9 }));
        assert!(receiver.blocking_recv().is_none());
    }

    #[test]
    fn queued_shutdown_is_cancellable_before_its_bounded_commit_window() {
        let now = tokio::time::Instant::now();
        let mut pending = PendingControlActions::default();
        assert!(!pending.apply(ControlAction::Shutdown { request_id: 41 }, now));
        assert_eq!(
            pending.next_shutdown_deadline(),
            Some(now + CONTROL_SHUTDOWN_CANCEL_WINDOW)
        );
        assert!(!pending.apply(
            ControlAction::Cancel {
                request_id: 42,
                request_to_cancel: 41,
            },
            now,
        ));
        assert_eq!(pending.next_shutdown_deadline(), None);
        assert!(pending.apply(ControlAction::Close { request_id: 43 }, now));
    }
}
