# Main network-recovery decline precondition

- Status: Proposed native contract repair; final exact-main acceptance required
- Owner: Desktop maintainers; accountable maintainer heeh02
- Last verified: 2026-10-04
- Applies to: test-only source after `main@710d47bcc9431d735ebf41a446da6bd325ef3e93`
- Supersedes: fixed2500ms delay treated as proof that ordinary automatic recovery was declined

## Original observation and limits

CI37195558001 attempt1/native job111416569474 failed while waiting for manual connection after
declined ordinary recovery. Other eight jobs passed. The fixture-only preceding commit changes
no production source; one local exact-source native sequence passed. The failed log supplies no
phase/attempt/recovery snapshot, so it does not establish a production root cause. No workflow
rerun was requested, and that failed run remains a failed observation.

The fixture previously slept2500ms after an online file write and checked attempt count1.
Neither proves that Main observed online, finished its1500ms recovery debounce/eligibility
operation and actually declined automatic recovery before the manual command. The test claims
to check manual connection *after decline*, not manual connection during an unfinished decision.

## Deterministic RED and strengthened contract

Through the existing test-only real-Main Connection subclass seam, ordinary network-online
eligibility is delayed4000ms, then delegated to the original method/policy. Initial-network-online
eligibility remains undelayed. No production strategy, timers, settings or network implementation
is replaced. The actual declined callback is counted by the same subclass, then delegates to the
original callback. The real startup factory's returned monitor is captured for observation only.

Requiring an actual decline on the unchanged fixed-delay sequence failed deterministically:
phase connectivity-paused, connected false, attempt count1, decline count0, baseline online.
This proves the missing fixture precondition, not the unique cause of the original CI timeout.

The fixed sleep is replaced by the existing bounded wait for actual decline count1, canonical
idle phase and unchanged attempt count1. Only then is the existing manual connect command sent.
All initial/ordinary/manual/queued-cancel assertions remain, including generation counts0/1/2,
autoReconnect=false and cancelled queued work starting0 additional Engine generations.

The45s hard timeout and15s wait budget remain unchanged. The4000ms delay is controlled fault input,
not an increased deadline or production polling/debounce change. The slow decision remains part
of the normal native fixture, so CI exercises the boundary rather than relying on runner speed.

On failure, only the latest bounded synthetic stage/phase/connected/count/decline and monitor
baseline/poll-in-flight observation is emitted. No full state, credential, user identifier,
private URL, raw Engine event or real network observation is printed. All profiles and loopback
Engine/network signals remain synthetic and owned.

## Evidence and rollback

Local actual Main sequence passes with the slow decision: initial network startup and queued
startup cancellation markers both PASS. Complete Desktop suite2,063 cases:2,047 pass,16 platform
skip,0 failures. Architecture/governance/install-script/syntax/exact-tree secret/whitespace and
unchanged production/dependency/CI trees remain pre-push gates. Exact-head seven required
contexts/three native packages and repaired final-main checks remain acceptance gates.

This is one E2E fixture plus this scoped note. No runtime, protocol, GUI, dependency/lock, CI,
release, installed application, active Clash/system proxy/TUN/DNS/route change. It is not an
original Windows/login or real-school result. The broader goal and remaining M2 open-lifetime
work are not completed by this synchronization repair.

Revert fixture/note together; no migration. That restores the guessed-sleep precondition and
missing diagnostic observations. Preserve the original failed CI record and do not claim an
unobserved production cause from a later green fixture.
