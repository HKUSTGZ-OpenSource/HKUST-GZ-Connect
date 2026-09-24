# Campus-data module review boundary

- Status: Proposed; not merged, installed or released
- Owner: Desktop Renderer maintainers
- Last verified: 2026-09-10
- Applies to: Issue #79; structural follow-up to published 2.0.2 at `39850415c901aeaa77ecb86cd3ce49a2e75290a8`

## Public contract

`renderer/features/campus-data/index.mjs` exports `create`, `weekRange`,
`scheduleWeekModel` and `scheduleWeekLayout`. The controller receives its document,
bounded Preload API, translation, HTML escaping, deep-link callback and catalog callback
from the application. It does not discover dependencies through Window.

The internal calendar model owns week boundaries, cross-day segments and compact event grouping.
The controller retains the existing rendering, in-memory 12-week cache, 24-hour refresh interval,
manual refresh, last-good rendering, authentication expiry and clear-display behavior.
No algorithm or lifecycle changes are included in this extraction.

The delivered pending-week correction in PR #106 is preserved: an uncached week keeps seven
day columns and a compact busy grid, never the previous week's events or a false empty result.
The controller retains only numeric layout bounds for that transition and clears them with its
display state. The view receives/returns those bounds through explicit internal parameters;
the public feature API remains unchanged. See the [preservation receipt](../archive/audits/2026-09-08-calendar-fix-preservation.md).

The internal `calendar-view.mjs` owns table/navigation/summary markup. It receives the selected
date, size mode, clock callback, localization/escaping functions, state/source rendering callbacks
and detail-group publication callback explicitly. It has no document, Preload, storage or timer
access. The controller resets and owns visible detail bindings and applies the resulting HTML;
the view is not exported from the feature's public entrypoint. Detail activation and other campus
data surfaces remain controller responsibilities, not a claim that every UI concern is extracted.

Calendar presentation is owned by `features/campus-data/view.css`, loaded once after the shared
shell. Descendant rules use `:where(.module-schedule)` to constrain scope without increasing
specificity. Existing root-qualified loading/miniature rules retain their selectors. The parent
workspace's grid placement and the personal-category dialog rules remain in the shared shell.
The stylesheet has no category selectors or global week rules. Computed-style/geometry comparisons
cover the current full/miniature table, dialog and refresh/loading states on Mac and Windows.

`app.js` imports the public entrypoint as an ES module. Its trailing authentication UI script
also uses module scheduling so it cannot initialize ahead of the application. The authentication
implementation is unchanged; the ASAR test verifies one auth-challenge subscription.

The old `campusDataModules` global and HTML script entry are removed. Existing Node tests consume
the public entrypoint, while browser fixtures import it from file/ASAR URLs. Syntax validation
now checks .mjs files and HTML-declared module entrypoints in the selected Git tree; the existing
architecture graph includes their literal imports. No new dependencies or budget increases.

## Review and rollback

PR #106 is merged and 2.0.2 is published. This remains a structural contribution, not another
release request. Review its diff against the exact published main above; synchronize and revalidate
when the base changes, without rewriting public history.
Reverting the structural contribution restores the global facade;
no data migration or installed-app change is involved.

The full feature registry, locale ownership and stale-operation lifecycle follow-ups
remain separate M1 work. This first seam is not a claim that HTML/global ordering is fully removed.
Native installers, real-school behavior and signing are outside this source-only verification.

## Lifecycle follow-up — PR #114

The structural contract above describes #108; the separate lifecycle contribution owns start,
dispose and stale-result fencing. Its 2026-09-12 review also covers explicit browser-data clearing:
`clearDisplay` revokes cached state and pending publications before attempting UI effects. A failed
detail-dialog close must not prevent clearing its markup, the other module surfaces or the catalog.
Cleanup failures remain reported as an aggregate rather than being silently treated as success.

The browser-data settings consumer catches failures in either clear-state callback, restores the
button and requires fresh two-click confirmation before retrying. A failure before the Main clear
operation prevents that operation from running. Tests inject only synthetic errors and display data;
they do not clear the user's browser session. Both new regressions failed before the corresponding
fix and passed afterwards. No IPC, storage format, network or release change is included.

Mac Electron verification on 2026-09-12 uses production source `5f73088` and the expanded
`e2e/schedule-navigation.electron.js` fixture, with isolated temporary userData and HTTP(S) blocked.
The fixture passes date/week navigation, cached/manual refresh, grouped details, keyboard closure,
expiry recovery, 360/440/960/1440-pixel windows and 150% zoom. Seven days remain in bounds without
horizontal or nested vertical overflow; detail dialogs remain centered. An injected native-dialog
close failure still scrubs and detaches the prior detail DOM and retires a pending week reply.
Narrow and wide synthetic screenshots were inspected. This is Mac source/fixture evidence only,
not a packaged-app, real-school or Windows/Linux acceptance claim. The installed app was untouched.

Designated-host follow-up on 2026-09-12 checks source `64911bd30f1f3e0d8d8a03191dedd01c6e2f661f`.
The selected Renderer, tests and fixture archive was hash-verified before extraction on 5070
(SHA-256 `04a455b17bc6ebf21fdd77ea3a11e5711c7db616a09747e25b9c16e96d5d6dee`).
Windows Node and WSL Linux Node each pass all 29 targeted tests with no skips: browser-data settings,
campus-data lifecycle, schedule cache, calendar view and the native module contract. Both native
Electron runtimes pass `schedule-navigation.electron.js`, including the real-DOM close-failure
regression; Linux runs under Xvfb. Windows logs one GPU-process exit (code 34), so hardware
acceleration health is not established. The Linux Renderer-only tests use the extracted source on
the Windows-mounted filesystem; they do not verify Linux private-file or installation behavior.
Existing runtimes were reused with no dependency installation, build, cloud workflow or execution
policy change. These results close the targeted Windows/Linux omissions above, not the full suite,
package/signing, live-school or independent-review gates. No published source or artifact changed.

## Organization review handoff — 2026-09-12

The verified repair is submitted through the existing #114 branch in `HKUSTGZ-OpenSource`, not a
new PR. Its base remains #110; #115 is the direct descendant. A read-only merge-tree check against
#115 is conflict-free, but that does not update or validate the descendant: synchronize it once
the parent review checkpoint is agreed. No downstream branch history is rewritten by this handoff.
The batch uses `[skip ci]` to respect the maintainer's Actions budget. Required checks remain
unfulfilled rather than being represented as passed; independent review and release authority
remain separate. The production/test delta is unchanged from the recorded native validation.
