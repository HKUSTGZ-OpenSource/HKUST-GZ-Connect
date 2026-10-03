# Temporary profile cleanup owner wait

- Status: Proposed
- Owner: Desktop tooling maintainers; issue #167
- Last verified: 2026-09-27
- Applies to: `desktop/scripts/temp-profile-cleanup.js` and its tooling unit test

## Problem

The detached cleanup helper polls its parent PID at a fixed 50 ms interval for at most 600
attempts. The previous implementation fell through to recursive profile removal when that budget
expired, even if the parent was still alive. A polling deadline is not evidence that the owner has
released its temporary Electron profile.

## Proposed behavior

- A successful `process.kill(parentPid, 0)` probe means the owner is alive. Only an `ESRCH` result
  confirms that it is absent; `EPERM` and other probe errors are unknown and must not authorize
  deletion.
- Keep the existing 600-attempt / 50 ms budget. If the owner is alive or its state remains unknown
  when the budget expires, stop the detached watcher and preserve the profile. This is not cleanup
  success: the watcher does not resume later, and the retained directory must only be cleaned by a
  later operation after owner absence is confirmed. Do not extend the deadline.
- Delete only the already-validated direct child of `os.tmpdir()` after confirmed owner absence.
  The candidate does not change the target/PID validation boundary or introduce another cleanup
  policy.

## Evidence and limits

The tooling unit fixture evaluates the helper's generated child script in a VM with mocked spawn,
filesystem, process and timers. It checks live-owner budget exhaustion, confirmed exit, permission
and unknown probe errors, and PID/path boundaries without spawning a real process or mutating a real
profile. This repair addresses the cleanup helper's demonstrated behavior only; it does not
establish the cause of the separate Browser close stall in issue #162.

This is a proposed source candidate, not a merge, package or release claim. Reverting the candidate
restores the deadline-as-death bug; no user profile or shared dependency cache is part of the change.
