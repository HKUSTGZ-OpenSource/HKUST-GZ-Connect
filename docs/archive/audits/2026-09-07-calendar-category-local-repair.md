# Calendar and personal-category local repair

- Status: Historical local acceptance; not a public release
- Owner: Desktop/UI maintainers
- Last verified: 2026-09-07
- Applies to: code `7d296c4563bdc086483f95f30ac520add8054310`, tree `b81b2dda79fd6efbcbfe1442784d8d5b6ae21d11`
- Published base: `main@9e1135c05dc21998c66627e25477d4bd799cd5d7` (2.0.1)

## Delivered locally

- Date picker, previous/next week and return-to-current-week navigation reach an exact-schema
  Main IPC. Only a date and optional boolean refresh flag are accepted; the school endpoint and
  authenticated Session remain Main-owned. Selected-week queries use campus UTC+08 boundaries.
- Week caches are separate, bounded to 12 entries and expire after one day; manual refresh bypasses
  the selected cache. Invalidation or a changed partition/portal rejects late selected-week results.
- The final overview fits occupied hours into 180–300 CSS pixels, without a nested vertical
  scrollbar. Intersecting visual intervals become one full-width counted group instead of thin
  columns. Every original segment remains in its group detail view, with full title/time/location.
  Minimum-sized very short neighboring entries can share a group; the label says arrangements,
  not that every grouped entry is necessarily simultaneous. No inferred deduplication is performed.
- Non-empty personal categories have a header expansion button even below the preview limit.
  A wider dialog shows every resource. Personal header and underline-pager switches and official
  service switches use the same soft transform/opacity function and reduced-motion behavior.
- The earlier tall minute-scale local candidate was superseded after user screenshots demonstrated
  excessive blank space and unreadable concurrent columns. It is not the final design.

## Verification

Node 24.19.0 and Electron 43.2.0, local macOS arm64. Existing runtime/dependency paths were reused.

| Command/check | Result |
| --- | --- |
| `npm test` | 1,254 passed, 6 platform skips, 0 failed |
| `Electron e2e/schedule-navigation.electron.js` | PASS: arbitrary date, adjacent weeks, today, refresh, complete 3-entry group, Escape, narrow/wide/zoom, bounded height and no overlapping text/cards |
| `Electron e2e/category-expand.electron.js` | PASS: 1–2-item categories expand with all rows, Escape, narrow/wide, deck/pager timing and reduced motion |
| `Electron e2e/control-shell-layout.electron.js` | PASS: real control shell and synthetic calendar segments |
| `Electron e2e/resource-manager-layout.electron.js` | PASS |
| Architecture, repository/link governance, install-script checks | PASS |
| Exact-tree JavaScript syntax and secret checks | PASS |
| Package verifier, CPU architecture and deep strict codesign verification | PASS, macOS arm64, ad-hoc |
| Installed ASAR source comparison | Calendar, IPC and category renderer files match the repaired source |

One earlier isolated packaged-launch probe remained alive but needed forced cleanup after its
SIGTERM deadline; it is not counted as a clean-shutdown pass. Normal macOS quit of the installed
App completed before replacement. Non-fatal Electron `task_policy_set` warnings appeared in some
layout fixtures; assertions passed and those fixtures exited zero.

## Installation and boundaries

The final application replaced `/Applications/hkustgzconnect.app` after package verification and
normal quit, with a rollback copy retained during the swap. It was reopened and its installed
process observed. Installed `app.asar` SHA-256:

`fe041d5e1f269ca6d73202af94d7f7d9129ae4f154d08e0b026d6f0342c26448`

Its version remains 2.0.1 **local repair**, not a replacement for the published immutable 2.0.1
artifacts. Rust/native source, Profile assets and build inputs did not change; native arm64 inputs
were reused from the verified 2.0.1 package. Final signing was explicit ad-hoc; a discarded initial
build selected an unrelated local identity and was not installed. No user-data directory, saved
credentials, browser cookies or school authentication was read or migrated by this delivery.

After confirming the final payload and process, this task's old App backups, intermediate release
directory and temporary App output were removed. The original user-owned release evidence and
dependency caches were retained. Rollback can rebuild the preceding local commit or reinstall a
published package without a user-data migration.

Windows/Linux native execution, real school arbitrary-week API responses and post-transfer update
discovery were not tested in this batch. No push, remote merge, new Release, repository transfer,
protection change or live-school canary was performed. The wider governance/modularization goal
remains incomplete.

## Follow-up: miniature week and centered details

Code `8fe3c4cd28a4fca314e230839efdf46116924eb0` adds a width-responsive miniature week.
All seven weekday columns fit the actual card width; the narrow view keeps start time and
abbreviated title/count, and the full detail remains available on click. Its 140–180 CSS-pixel
body replaces the normal 180–300-pixel view at narrow widths. Resizing does not query the portal.
The Electron regression asserts seven nonzero-width header columns, correct Monday alignment,
no horizontal content overflow, and narrow/wide/zoom transitions, rather than merely hiding bars.

Code `5a67fcb` fixes the modal margin reset: week details and personal-category overlays explicitly
use fixed inset positioning, auto margins and content height. The centering assertion failed
before this fix. Afterward, 360/440/960/1440-width, zoom, long-content, viewport-margin and
category centering checks passed. Full Desktop tests: 1,255 passed, 6 platform skips, 0 failures;
architecture, governance, exact-tree syntax/secrets, package and signature checks passed.

The final local App was normally quit, replaced, reopened and verified at the same installed
path. Its ASAR SHA-256 is `d4b3139ed22a5dcb5c92124ab51ee958bd7b2316986059fcadf4f35993e3f956`.
This supersedes the earlier installed payload above, not its historical acceptance record.
User data remained untouched. This task's temporary App outputs and rollback copies were removed
after validation; published packages and committed source remain available for rollback.
No new public release, remote merge, transfer or native Windows/Linux claim was made.
