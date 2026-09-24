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
