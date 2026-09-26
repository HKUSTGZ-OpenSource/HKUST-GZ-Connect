# Desktop credential transaction ownership

- Status: Proposed M3 structural contract
- Owner: Desktop Persistence maintainers
- Last verified: 2026-09-27
- Applies to: development source based on `d61780e8`, not published installers

The existing `DesktopPersistenceRuntime` owns the legacy credential-settings
journal lifecycle: pre-ready recovery, the single blocked/retry state, persistence
admission, legacy-versus-Profile-Workspace mutation dispatch and recovery feedback.
It delegates durable rollback/commit mechanics to the existing
`credential-settings-transaction.js`; it does not copy that policy into Main or
IPC. The Runtime is constructed without filesystem reads, then
`prepareBeforeOwnerOnlyValidation()` recovers the journal and invokes Main's
owner-only validation effect in that order. A blocked result still permits the
existing private-file checks to run while keeping credential presence and writes
fail-closed.

Main supplies opaque paths from the selected pre-ready authority, storage
effects, the existing Settings/credential presentation ports and a validation
callback. It delegates later retries and mutation calls to the same Runtime
instance. The Settings IPC suite retains request schema checks, Profile identity
fences, one-shot in-memory fallback and request-reference clearing; its explicit
`credentialTransactions` dependency is the existing persistence owner, not a
second journal authority. Profile/Account/Workspace context, credential storage
formats, generation fences and migration/relaunch behavior do not change.

The owner also preserves the unavailable-protected-store path: only a synthetic,
Profile-bound one-shot credential can remain in memory; it is not journaled or
persisted. Corrupt/decryption failures continue to fail closed, and decrypted
credentials remain scoped to their existing disposable owner. No OTP or campus
browser behavior is involved in this slice.

## Ratchets and validation

At this candidate tree, Main is 1,008 lines / 32 direct / 46 effective / 170
transitive dependencies; the existing Runtime is 369 lines. Compared with the
preceding 1,084 / 33 / 47 / 170 snapshot, this removes 76 Main lines and one
direct edge without adding a transitive dependency. The current first-stage
dependency target (<30 direct) remains open, as do the later M3 stages.

Runtime tests use synthetic private files and an injected validation spy to prove
that an interrupted legacy transaction is restored before validation. Additional
tests retain transient-error blocking, retry, typed recovery feedback and
Profile-Workspace isolation. IPC tests retain stale-Profile rejection, synthetic
memory-only fallback and password-reference clearing. The Main source contracts
check that construction/preparation precede the existing validation loop and
that Main no longer imports or owns transaction/recovery algorithms.

Rollback reverts the Runtime methods, Main wiring, Settings IPC dependency,
contracts and tests together. No schema, persisted path, IPC payload, GUI,
protocol, dependency or user-data change is part of this extraction. Native
migration/upgrade and Main profile-relaunch checks remain distinct from synthetic
unit evidence; no live-school canary or installed-app replacement is authorized.
