# Browser toolbar presentation ownership

- Status: Proposed bounded M2 extraction; not full Browser lifecycle convergence
- Owner: Desktop Browser maintainers
- Last verified: 2026-09-29
- Applies to: staged candidate based on certificate-entrypoint PR head `dbf1a5a`, not development
  `main` or published v2.0.3

`BrowserToolbarOwner` owns the Browser chrome's sanitized toolbar state projection, duplicate
suppression, coalesced update timer and reset/cancel lifecycle. The existing `CampusBrowser`
constructs it with narrow callbacks for active tab, window, tabs, download, bookmark and favorite
presentation. Browser routing, navigation, certificate, credential, popup, download and workspace
behavior remain with their existing owners. The toolbar owner receives only bounded display state;
it does not read a Browser Session, cookies, OTP, credentials or persistence files.

The public toolbar command contract stays in its existing sandboxed Preload entrypoint; Main-only
projection is not mixed into that Preload. The new owner is private to the Browser domain.
Retirement increments a generation, cancels a queued timer and clears deduplication state, so a
queued callback from a prior window cannot publish into its replacement. `CampusBrowser` retains
thin method/getter compatibility for existing callers and diagnostics. The native window owner
still controls creation, close confirmation and teardown ordering.

The staged tree reduces `CampusBrowser` from 1,476 to 1,437 lines; the new toolbar owner is 116
lines. Main stays at 895 lines and 30 direct / 44 effective dependencies. The added Browser module
raises Main's transitive count from the certificate candidate's 169 to the existing cap of 170;
it does not raise any budget. If the certificate candidate is not merged, this stacked extraction
must not be treated as independently mergeable onto the previous 170-module baseline.

Synthetic unit tests cover projection fields, duplicate suppression, idempotent teardown, queued
callback retirement, replacement windows, destroyed renderers and failed-send retry. Existing
Browser/toolbar, MFA, routing, profile and package tests remain separate acceptance gates. These
checks are not live-school Browser or authenticated-session evidence. There is no IPC payload,
persisted schema, platform setting, user-data migration, Engine change or release in this slice.

Rollback this Browser session wrapper, owner, unit tests and ownership record together. The
rebased branch retains the original three-path Browser candidate plus the added tests and record;
it is not an additional production authority before review and merge.
