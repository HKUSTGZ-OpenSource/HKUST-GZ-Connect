# Desktop persistence-read ownership

- Status: Proposed M3 structural contract
- Owner: Desktop Persistence maintainers
- Last verified: 2026-09-27
- Applies to: development source after v2.0.3, not published installers

`DesktopPersistenceRuntime` owns the legacy file adapter and opt-in settings-read
presentation. Main supplies the already selected settings/credential paths,
safeStorage/platform, current Profile defaults, recovery observer and translated
presentation effects. The existing Runtime constructor still accepts injected legacy
stores, while its factory composes the production stores without another policy.
The reporting methods require the injected `settingsPresentation` ports; callers
without presentation continue to use the unchanged raw `loadSettings()` API.

Creating the adapter performs no I/O. Pre-ready journal recovery, permission checks,
Profile selection and after-ready migration/relaunch stay in their existing order.
Credential opening reads legacy settings before the typed credential result;
missing returns null, failure retains `credentialStatus`, and decrypted data enters
the existing disposable/redacted migration credential owner. No credentials are
cached on the adapter or projected to Renderer. Password storage, Linux memory
fallback, private-file validation and Profile/Account/Workspace ownership are unchanged.

Read-error feedback retains `SETTINGS_READ_FAILED`, its bounded user message,
current translation, silent startup option and deduplicated emissions. Recovery
clears only the read owner's matching notice, never another settings, recovery,
Browser or log outcome. Main keeps thin injected entrypoints; the implementation
no longer remains duplicated in the composition root.

## Ratchets and validation

Main falls 1,136 → 1,084 lines, direct dependencies 34 → 33 and effective direct
dependencies 49 → 47. The existing persistence runtime is 239 lines. No new runtime
module, dependency or transitive-budget increase is introduced; #81 remains open.

Tests exercise current Profile defaults, settings-before-credential ordering,
typed storage failures, owner destruction/redaction, save/clear/presence effects,
actual private-file stores with synthetic encryption, translation changes,
deduplication, silent reporting and unrelated-notice preservation. Source contracts
verify Main's injected ports and the relocated implementation without deleting the
original Profile/security assertions. Full Desktop, native Engine lifecycle,
Profile-switch and legacy migration, architecture/governance/install-script/syntax,
exact-tree secret and three-platform package checks remain required. A timed-out
native run is not passing evidence; compare baseline and candidate before rerunning.

Rollback reverts the adapter/read methods, Main wiring, tests and ratchets together.
No data/schema/IPC/GUI/protocol migration, global routing change, live-school canary
or installed-app replacement occurs. Synthetic success cannot resolve report #127.
