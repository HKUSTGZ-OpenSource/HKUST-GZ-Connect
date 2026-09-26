//! Binary-private connection-attempt coordination.
//! Cancellation wins over worker promotion; domain callers own result cleanup.
use super::engine_control::{
    ControlInput, PendingControlActions, receive_control, wait_for_control_shutdown,
};
use super::engine_events::EngineLifecycle;
use ec_compat::engine::auth_lifecycle::BlockingOperation;
use ec_compat::{Error, ErrorKind, Result};
use std::io::Write;
use std::time::Duration;

// A cooperative worker normally observes cancellation between its bounded
// network operations within milliseconds. Do not let an in-flight blocking
// socket outlive Desktop's graceful-control envelope: after this drain window
// the process reports cleanup-unconfirmed and exits fail-closed. The worker
// cannot promote a result because its owner is dropped with the process.
const CONNECTION_OPERATION_CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
pub(super) enum ConnectionOperationCancellationCause {
    UserRequested,
    DeadlineExpired,
    SignalFailed(Error),
    ControlOutputFailed(Error),
}

pub(super) enum ConnectionOperationOutcome<S, E> {
    Completed(std::result::Result<S, E>),
    WorkerFailed(Error),
    Cancelled {
        cause: ConnectionOperationCancellationCause,
        completion: Result<std::result::Result<S, E>>,
    },
}

pub(super) async fn drive_blocking_connection_operation<S, E, W: Write>(
    operation: &mut BlockingOperation<S, E>,
    deadline: tokio::time::Instant,
    control_receiver: &mut Option<tokio::sync::mpsc::Receiver<ControlInput>>,
    pending_control_actions: &mut PendingControlActions,
    lifecycle: &mut EngineLifecycle<W>,
) -> ConnectionOperationOutcome<S, E>
where
    S: Send + 'static,
    E: Send + 'static,
{
    let signal = shutdown_signal();
    tokio::pin!(signal);
    let cause = loop {
        let control_shutdown_deadline = pending_control_actions.next_shutdown_deadline();
        // An elapsed deadline is committed state, even if a newly polled
        // Tokio timer first needs to register with its driver. Do not let an
        // already completed worker (or a late cancel frame) overtake it.
        if control_shutdown_deadline.is_some_and(|deadline| deadline <= tokio::time::Instant::now())
        {
            break ConnectionOperationCancellationCause::UserRequested;
        }
        tokio::select! {
            // Promotion is the lowest-priority outcome.  If a blocking worker
            // finishes at the same instant as its owner closes the private
            // control pipe (or a previously accepted shutdown commits), the
            // stop boundary must win so a stale Auth/Transport result cannot
            // be promoted into listener resources.
            biased;
            _ = wait_for_control_shutdown(control_shutdown_deadline), if control_shutdown_deadline.is_some() => {
                break ConnectionOperationCancellationCause::UserRequested;
            }
            signal = &mut signal => {
                break match signal {
                    Ok(()) => ConnectionOperationCancellationCause::UserRequested,
                    Err(error) => ConnectionOperationCancellationCause::SignalFailed(error),
                };
            }
            _ = async {
                // Preserve signal precedence while making an already elapsed
                // operation deadline ready on its first poll.
                if deadline > tokio::time::Instant::now() {
                    tokio::time::sleep_until(deadline).await;
                }
            } => {
                break ConnectionOperationCancellationCause::DeadlineExpired;
            }
            input = receive_control(control_receiver), if control_receiver.is_some() => {
                let Some(input) = input else {
                    // Before listener readiness, the inherited private pipe is
                    // part of the connection-attempt owner boundary. Losing it
                    // cancels auth or transport so no session continues without
                    // its generation controller.
                    *control_receiver = None;
                    break ConnectionOperationCancellationCause::UserRequested;
                };
                match input {
                    ControlInput::V2(exchange) => {
                        if let Err(error) = lifecycle.emit_control(&exchange) {
                            break ConnectionOperationCancellationCause::ControlOutputFailed(error);
                        }
                        if let Some(action) = exchange.action
                            && pending_control_actions.apply(action, tokio::time::Instant::now())
                        {
                            *control_receiver = None;
                            break ConnectionOperationCancellationCause::UserRequested;
                        }
                    }
                    ControlInput::V3(request) => {
                        if let Err(error) = lifecycle.reject_auth_control(&request) {
                            break ConnectionOperationCancellationCause::ControlOutputFailed(error);
                        }
                    }
                }
            }
            completion = operation.wait() => {
                return match completion {
                    Ok(result) => ConnectionOperationOutcome::Completed(result),
                    Err(error) => ConnectionOperationOutcome::WorkerFailed(error),
                };
            }
        }
    };

    operation.cancel();
    let completion =
        match tokio::time::timeout(CONNECTION_OPERATION_CANCEL_DRAIN_TIMEOUT, operation.wait())
            .await
        {
            Ok(completion) => completion,
            Err(_) => Err(Error::classified(
                ErrorKind::Lifecycle,
                "connection operation did not stop within its cancellation drain deadline",
            )),
        };
    ConnectionOperationOutcome::Cancelled { cause, completion }
}

#[cfg(unix)]
pub(super) async fn shutdown_signal() -> Result<()> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut terminate = signal(SignalKind::terminate())
        .map_err(|_| Error("cannot install termination signal handler".into()))?;
    tokio::select! {
        signal = tokio::signal::ctrl_c() => {
            signal.map_err(|_| Error("cannot install interrupt signal handler".into()))
        }
        _ = terminate.recv() => Ok(()),
    }
}

#[cfg(not(unix))]
pub(super) async fn shutdown_signal() -> Result<()> {
    tokio::signal::ctrl_c()
        .await
        .map_err(|_| Error("cannot install interrupt signal handler".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ec_compat::engine::control::{ControlAction, ControlExchange};

    #[tokio::test]
    async fn elapsed_operation_deadline_outranks_a_completed_worker() {
        for round in 0..32 {
            let mut operation = BlockingOperation::spawn(|_| Ok::<_, ()>("completed"));
            tokio::time::timeout(Duration::from_secs(1), async {
                while !operation.is_finished() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            let mut receiver = None;
            let mut pending = PendingControlActions::default();
            let mut lifecycle = EngineLifecycle::new(Vec::new(), 23);
            let outcome = drive_blocking_connection_operation(
                &mut operation,
                tokio::time::Instant::now(),
                &mut receiver,
                &mut pending,
                &mut lifecycle,
            )
            .await;
            let ConnectionOperationOutcome::Cancelled { cause, completion } = outcome else {
                panic!("expired operation deadline lost to promotion at round {round}");
            };
            assert!(matches!(
                cause,
                ConnectionOperationCancellationCause::DeadlineExpired
            ));
            assert_eq!(completion.unwrap(), Ok("completed"));
        }
    }

    #[tokio::test]
    async fn uncommitted_or_cancelled_shutdown_does_not_discard_a_ready_result() {
        for cancel in [false, true] {
            let mut operation = BlockingOperation::spawn(|_| Ok::<_, ()>("completed"));
            tokio::time::timeout(Duration::from_secs(1), async {
                while !operation.is_finished() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("fixture worker must complete");
            let mut receiver = None;
            let mut pending = PendingControlActions::default();
            let mut lifecycle = EngineLifecycle::new(Vec::new(), 21);
            let now = tokio::time::Instant::now();
            pending.apply(ControlAction::Shutdown { request_id: 21 }, now);
            if cancel {
                pending.apply(
                    ControlAction::Cancel {
                        request_id: 22,
                        request_to_cancel: 21,
                    },
                    now,
                );
            }
            let outcome = drive_blocking_connection_operation(
                &mut operation,
                now + Duration::from_secs(1),
                &mut receiver,
                &mut pending,
                &mut lifecycle,
            )
            .await;
            assert!(matches!(
                outcome,
                ConnectionOperationOutcome::Completed(Ok("completed"))
            ));
            assert!(!operation.is_cancelled());
        }
    }

    #[tokio::test]
    async fn committed_shutdown_outranks_an_already_completed_worker() {
        for round in 0..32 {
            let mut operation = BlockingOperation::spawn(|_| Ok::<_, ()>("completed"));
            tokio::time::timeout(Duration::from_secs(1), async {
                while !operation.is_finished() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("fixture worker must be ready before testing precedence");
            let mut receiver = if round % 2 == 0 {
                None
            } else {
                let (sender, receiver) = tokio::sync::mpsc::channel(1);
                sender
                    .try_send(ControlInput::V2(ControlExchange {
                        response: ec_compat::engine::control::ControlResponse::Result {
                            api_version: 2,
                            request_id: 20,
                            status: ec_compat::engine::control::ControlStatus::Cancelled,
                        },
                        action: Some(ControlAction::Cancel {
                            request_id: 20,
                            request_to_cancel: 19,
                        }),
                    }))
                    .unwrap();
                Some(receiver)
            };
            let mut pending = PendingControlActions::default();
            let mut lifecycle = EngineLifecycle::new(Vec::new(), 19);
            // Enter exactly at the existing 100 ms commit boundary, not long
            // afterward: a newly polled timer may not be driver-ready yet.
            let now = tokio::time::Instant::now();
            pending.apply(
                ControlAction::Shutdown { request_id: 19 },
                now - Duration::from_millis(100),
            );
            let outcome = drive_blocking_connection_operation(
                &mut operation,
                now + Duration::from_secs(1),
                &mut receiver,
                &mut pending,
                &mut lifecycle,
            )
            .await;
            let ConnectionOperationOutcome::Cancelled { cause, completion } = outcome else {
                panic!("committed shutdown lost to worker promotion at round {round}");
            };
            assert!(matches!(
                cause,
                ConnectionOperationCancellationCause::UserRequested
            ));
            assert_eq!(completion.unwrap(), Ok("completed"));
            assert!(operation.is_cancelled());
            if let Some(receiver) = receiver {
                assert_eq!(
                    receiver.len(),
                    1,
                    "late cancel must not reverse committed shutdown"
                );
            }
        }
    }

    #[tokio::test]
    async fn control_output_failure_cancels_and_collects_the_worker() {
        struct FailedWriter;
        impl Write for FailedWriter {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut operation = BlockingOperation::spawn(|cancellation| {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while !cancellation.is_cancelled() && std::time::Instant::now() < deadline {
                std::thread::yield_now();
            }
            Ok::<_, ()>(cancellation.is_cancelled())
        });
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        sender
            .send(ControlInput::V2(ControlExchange {
                response: ec_compat::engine::control::ControlResponse::Result {
                    api_version: 2,
                    request_id: 17,
                    status: ec_compat::engine::control::ControlStatus::Accepted,
                },
                action: None,
            }))
            .await
            .unwrap();
        let mut receiver = Some(receiver);
        let mut pending = PendingControlActions::default();
        let mut lifecycle = EngineLifecycle::new(FailedWriter, 17);
        let outcome = drive_blocking_connection_operation(
            &mut operation,
            tokio::time::Instant::now() + Duration::from_secs(3),
            &mut receiver,
            &mut pending,
            &mut lifecycle,
        )
        .await;
        let ConnectionOperationOutcome::Cancelled { cause, completion } = outcome else {
            panic!("failed control output must prevent result promotion");
        };
        assert!(matches!(
            cause,
            ConnectionOperationCancellationCause::ControlOutputFailed(_)
        ));
        assert_eq!(completion.unwrap(), Ok(true));
    }

    #[tokio::test]
    async fn connection_operation_close_cancels_and_collects_its_late_result() {
        let mut operation = BlockingOperation::spawn(|cancellation| {
            while !cancellation.is_cancelled() {
                std::thread::yield_now();
            }
            Ok::<_, ()>("late-transport-result")
        });
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        sender
            .send(ControlInput::V2(ControlExchange {
                response: ec_compat::engine::control::ControlResponse::Result {
                    api_version: 2,
                    request_id: 7,
                    status: ec_compat::engine::control::ControlStatus::Accepted,
                },
                action: Some(ControlAction::Close { request_id: 7 }),
            }))
            .await
            .unwrap();
        let mut receiver = Some(receiver);
        let mut pending_control_actions = PendingControlActions::default();
        let mut lifecycle = EngineLifecycle::new(Vec::new(), 9);
        let outcome = drive_blocking_connection_operation(
            &mut operation,
            tokio::time::Instant::now() + Duration::from_secs(1),
            &mut receiver,
            &mut pending_control_actions,
            &mut lifecycle,
        )
        .await;
        let ConnectionOperationOutcome::Cancelled { cause, completion } = outcome else {
            panic!("control close must cancel the connection-stage worker");
        };
        assert!(matches!(
            cause,
            ConnectionOperationCancellationCause::UserRequested
        ));
        assert_eq!(completion.unwrap(), Ok("late-transport-result"));
    }

    #[tokio::test]
    async fn accepted_shutdown_survives_an_operation_phase_transition() {
        let mut first = BlockingOperation::spawn(|_| Ok::<_, ()>("authenticated"));
        tokio::time::timeout(Duration::from_secs(1), async {
            while !first.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the synthetic first phase must finish before driving the control race");
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        sender
            .send(ControlInput::V2(ControlExchange {
                response: ec_compat::engine::control::ControlResponse::Result {
                    api_version: 2,
                    request_id: 8,
                    status: ec_compat::engine::control::ControlStatus::Accepted,
                },
                action: Some(ControlAction::Shutdown { request_id: 8 }),
            }))
            .await
            .unwrap();
        let mut receiver = Some(receiver);
        let mut pending_control_actions = PendingControlActions::default();
        let mut lifecycle = EngineLifecycle::new(Vec::new(), 11);
        let first_outcome = drive_blocking_connection_operation(
            &mut first,
            tokio::time::Instant::now() + Duration::from_secs(1),
            &mut receiver,
            &mut pending_control_actions,
            &mut lifecycle,
        )
        .await;
        assert!(matches!(
            first_outcome,
            ConnectionOperationOutcome::Completed(Ok("authenticated"))
        ));
        assert!(pending_control_actions.next_shutdown_deadline().is_some());

        let mut second = BlockingOperation::spawn(|cancellation| {
            while !cancellation.is_cancelled() {
                std::thread::yield_now();
            }
            Ok::<_, ()>("late-transport")
        });
        let second_outcome = drive_blocking_connection_operation(
            &mut second,
            tokio::time::Instant::now() + Duration::from_secs(1),
            &mut receiver,
            &mut pending_control_actions,
            &mut lifecycle,
        )
        .await;
        let ConnectionOperationOutcome::Cancelled { cause, completion } = second_outcome else {
            panic!("the accepted shutdown must commit in the next phase");
        };
        assert!(matches!(
            cause,
            ConnectionOperationCancellationCause::UserRequested
        ));
        assert_eq!(completion.unwrap(), Ok("late-transport"));
    }

    #[tokio::test]
    async fn connection_operation_deadline_cancels_and_collects_its_late_result() {
        let mut operation = BlockingOperation::spawn(|cancellation| {
            while !cancellation.is_cancelled() {
                std::thread::yield_now();
            }
            Ok::<_, ()>("deadline-result")
        });
        let mut receiver = None;
        let mut pending_control_actions = PendingControlActions::default();
        let mut lifecycle = EngineLifecycle::new(Vec::new(), 10);
        let outcome = drive_blocking_connection_operation(
            &mut operation,
            tokio::time::Instant::now() + Duration::from_millis(10),
            &mut receiver,
            &mut pending_control_actions,
            &mut lifecycle,
        )
        .await;
        let ConnectionOperationOutcome::Cancelled { cause, completion } = outcome else {
            panic!("deadline must cancel the connection-stage worker");
        };
        assert!(matches!(
            cause,
            ConnectionOperationCancellationCause::DeadlineExpired
        ));
        assert_eq!(completion.unwrap(), Ok("deadline-result"));
    }

    #[tokio::test]
    async fn connection_operation_owner_eof_cancels_and_collects_its_late_result() {
        let mut operation = BlockingOperation::spawn(|cancellation| {
            while !cancellation.is_cancelled() {
                std::thread::yield_now();
            }
            Ok::<_, ()>("owner-eof-result")
        });
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        drop(sender);
        let mut receiver = Some(receiver);
        let mut pending_control_actions = PendingControlActions::default();
        let mut lifecycle = EngineLifecycle::new(Vec::new(), 12);
        let outcome = drive_blocking_connection_operation(
            &mut operation,
            tokio::time::Instant::now() + Duration::from_secs(1),
            &mut receiver,
            &mut pending_control_actions,
            &mut lifecycle,
        )
        .await;
        let ConnectionOperationOutcome::Cancelled { cause, completion } = outcome else {
            panic!("owner EOF must cancel the connection-stage worker");
        };
        assert!(matches!(
            cause,
            ConnectionOperationCancellationCause::UserRequested
        ));
        assert_eq!(completion.unwrap(), Ok("owner-eof-result"));
        assert!(receiver.is_none());
    }

    #[tokio::test]
    async fn connection_operation_owner_eof_wins_over_ready_worker_completion() {
        let mut operation = BlockingOperation::spawn(|_| Ok::<_, ()>("completed"));
        // Make both branches ready before entering the coordinator.  A random
        // select winner used to let the result escape the pre-listener owner
        // boundary intermittently.
        tokio::time::sleep(Duration::from_millis(10)).await;
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        drop(sender);
        let mut receiver = Some(receiver);
        let mut pending_control_actions = PendingControlActions::default();
        let mut lifecycle = EngineLifecycle::new(Vec::new(), 13);
        let outcome = drive_blocking_connection_operation(
            &mut operation,
            tokio::time::Instant::now() + Duration::from_secs(1),
            &mut receiver,
            &mut pending_control_actions,
            &mut lifecycle,
        )
        .await;
        let ConnectionOperationOutcome::Cancelled { cause, completion } = outcome else {
            panic!("owner EOF must outrank a simultaneously ready worker result");
        };
        assert!(matches!(
            cause,
            ConnectionOperationCancellationCause::UserRequested
        ));
        assert_eq!(completion.unwrap(), Ok("completed"));
        assert!(receiver.is_none());
    }

    #[tokio::test]
    async fn non_cooperative_connection_operation_fails_closed_within_drain_deadline() {
        let (release, release_rx) = std::sync::mpsc::channel();
        let mut operation = BlockingOperation::spawn(move |_| {
            release_rx.recv().unwrap();
            Ok::<_, ()>("too-late")
        });
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        drop(sender);
        let mut receiver = Some(receiver);
        let mut pending_control_actions = PendingControlActions::default();
        let mut lifecycle = EngineLifecycle::new(Vec::new(), 14);
        let started = tokio::time::Instant::now();
        let outcome = drive_blocking_connection_operation(
            &mut operation,
            tokio::time::Instant::now() + Duration::from_secs(5),
            &mut receiver,
            &mut pending_control_actions,
            &mut lifecycle,
        )
        .await;
        let ConnectionOperationOutcome::Cancelled { cause, completion } = outcome else {
            panic!("owner EOF must cancel a non-cooperative operation");
        };
        assert!(matches!(
            cause,
            ConnectionOperationCancellationCause::UserRequested
        ));
        let error = completion.unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Lifecycle);
        assert!(started.elapsed() < Duration::from_secs(2));
        // Let the detached blocking task finish before this test runtime shuts
        // down; production exits the Engine process after emitting the typed
        // cleanup-unconfirmed terminal outcome.
        release.send(()).unwrap();
    }
}
