# Desktop Engine attempt ownership

- Status: Proposed M3 structural contract
- Owner: Desktop Connection maintainers
- Last verified: 2026-09-27
- Applies to: development source after v2.0.3, not published installer contents

`EngineAttemptCoordinator` in the existing `engine-process.js` owns one connection
attempt: underlay observation, final settings/credential snapshot, process launch,
generation callbacks, private stdin prefix and protocol-runtime startup. Main wires
bounded effects and retains the process supervisor, FSM and persistence authorities.

Profile/config verification precedes credential access. The last pre-spawn async yield
remains log reset; the subsequent snapshot, owner disposal, spawn and stdin prefix
stay synchronous. Passwords never enter argv, logs, Renderer or coordinator properties.
The coordinator consumes an injected `openCredential(profileId)` port. Main wires the
existing `openVpnCredential` selector, preserving #151/#152 rather than copying the
historical persistent-or-memory expression. Both memory fallback and typed failures
stay in the persistence domain. Serving/termination use the current runtime, including
#156/#157's retired-context error fences.

Windows durable owner records, orphan cleanup, strict/optional proxy framing, Control
v2 admission and exit/close drain remain unchanged. Current intent/generation/context
is rechecked after async observation and log reset. Existing transient strings are
cleared after stdin delivery; one-use credential buffers are destroyed before spawn.

## Ratchets and validation

Main falls from 1,509 to 1,247 lines, its cap falls to 1,247, direct dependency cap to
35 and effective direct cap to 50. The Engine process module remains below 600 lines;
transitive and other architecture budgets are not raised. This is not completion of
M3's first 1,200/30 stage or final 500–700/20 target.

Owner tests exercise real FSM/protocol admission, source precedence through the actual
selector, no-yield ordering, changes during pending log reset, credential disposal,
invalid binding/input, orphan cleanup, generation/proxy mismatch and Windows owner
failure. Main contracts follow the moved algorithm while verifying injected authorities,
reviewed binding and exact stdin ordering. Full Desktop, native synthetic lifecycle,
Profile-switch, architecture, secret and package gates remain required. Offline fixtures
do not prove live Gateway/MFA or native Windows acceptance from macOS mocks.

The package verifier reads the attempt owner from the actual ASAR and checks Main's
profile-verification injection, binding-before-credential/spawn ordering and private
stdin prefix. Missing owner/injection/binding/frame and argv digest regressions fail
closed. The original inline-owner flag/digest checks remain supported; moving a guard
does not remove the package gate or substitute source-tree tests for packaged bytes.

Rollback reverts this extraction, wiring, tests and matching ratchets together. The
credential selector and callback-fence prerequisite fixes remain independent. No data,
schema, new authentication capability, system-network or installed-App migration occurs.
