# Desktop VPN credential access owner

- Status: Current merged bounded M3 ownership; not a release or complete Main composition
- Owner: Desktop Persistence maintainers
- Last verified: 2026-10-03
- Applies to: merged #210; verified development `main@eb5a60743427286e5af5c6eafce48d4ddaa5b63d`, not v2.0.3

The existing Persistence public runtime creates `VpnCredentialAccessCoordinator`
through one explicit factory. The coordinator lives beside the existing credential
store, owns the process-memory broker and delegates to the existing persistence,
selection, availability and error-key functions. Field parsing is injected by the
public runtime from the existing canonical settings primitive; it is not copied
into another policy or made a dependency of the low-level memory broker.

Main constructs/injects the coordinator and uses its bounded presence, open,
stage, revision-scoped clear and validation methods. Status presence checks still
do not decrypt or prompt for Keychain access. Protected persistent ownership wins;
only typed unavailable or missing storage may use an explicitly staged,
Profile-bound memory credential. Corrupt, failed-decryption, retired-context and
blocked-recovery failures retain their identity and fail closed. Memory owners
keep their synchronous use/zeroization and explicit shutdown/switch/replace cleanup.

Construction calls no persistence, Profile, Engine or storage effect. Existing
Engine/context validation, credential journal/storage, portal-password sharing,
save/clear transactions, IPC and migration owners remain unchanged. The coordinator
and broker are Main-only and have redacted diagnostics; no secret crosses Renderer.

Before movement, 13 existing store/broker contracts passed. Seven new public-seam
tests initially failed because the factory was absent, not because a live failure
had been proved; all seven pass after implementation. Native startup, migration,
Profile/credential, Engine lifecycle and exact-source/platform checks remain
separate acceptance gates. No real account, installed application or network change.

The three retired Main private-import edges are removed from the frozen inventory
and its ceiling drops 113 -> 110 at the #210 slice. Main goes 819 -> 800 lines and
30 -> 27 direct dependencies without a new production module or transitive graph growth.
That slice did not reach below-800/24; #212 later reaches that stage. Final M3 composition
remains open; current totals belong to the implementation index, not these historical slice counts.

Rollback the coordinator, public factory, Main wiring, tests and debt ratchet as a
unit. The original store and memory-broker APIs remain available; no schema or
user-data migration is required.
