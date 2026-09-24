# Calendar module review acceptance

- Status: Historical acceptance; synchronized-source result below; review/CI/release gates pending
- Owner: Desktop Renderer maintainers
- Verified: 2026-09-08
- Scope: Issue #79; structural follow-up to PR #106
- Base: `48140fd189b073af28dc4f6f24430b116ff0a22c`
- Code: `d8c7de9c10e1f44d0e89ec4f6c636ac7130fb313`
- Tested tree: `44f5418f1d68a8169780a852d4fb605cca1a4359`

## Change and isolation

The 582-line global campus-data facade becomes a 472-line controller, 102-line calendar model
and two-line public entrypoint. Both the controller function body and calendar model function
bodies were compared with the base after removing indentation/export syntax: exact parity.
Cache capacity, refresh policy, clear behavior, DOM/CSS, IPC, storage, dependencies and native
code are unchanged. The application imports this feature instead of depending on a Window export.

This contribution intentionally excludes the separate lifecycle, calendar-view extraction,
shared feature registry, locale and category behavior candidates. It is stacked on PR #106,
not a replacement release branch and not proof that M1 is complete.

## Actual verification

- Mac focused module/cache/calendar/Renderer/syntax contract tests: 36 passed.
- Native Windows Node 24.20.0 on the designated 5070 host: the same 36 passed, 0 skipped.
  This run used the RBMS Windows SSH entrypoint, not a simulated Windows platform.
- 5070 Linux Node 24.20.0 full Desktop suite under umask 022: 1272 passed, 6 platform skips,
  0 failures. Isolated Git checkout matched the exact code commit; Windows used its Git archive.
- Mac Electron schedule navigation: PASS, including dates, cache/refresh, grouped details,
  narrow/wide/zoom, keyboard and minute geometry.
- Mac Electron native-module ASAR loading: PASS, seven days, no legacy campus-data global,
  and exactly one authentication subscription.
- Mac Electron resource-manager, campus-workspace and category-expand layout fixtures: PASS.
- Mac Electron campus-popup MFA credential-safety fixture: PASS.
- Architecture, install-script allowlist, governance, staged secret scan and exact-tree syntax:
  PASS; syntax enumerated 473 .js/.mjs sources.

Focused command from desktop:

```sh
node --test test/unit/renderer/campus-data-module.test.js test/unit/renderer/schedule-cache.test.js test/unit/renderer/schedule-calendar.test.js test/renderer-contract.test.js test/javascript-syntax-gate.test.js
```

## Failing gate and remaining evidence

`electron e2e/control-shell-layout.electron.js` failed on both the unchanged base and this
candidate at the identical first-page personal-category assertion: actual 3, expected 5
(line 554). The fixture still assumes the old deck count while the base already contains
responsive category behavior. Its later checks were not executed in this run. This is observed
baseline debt, not a passing gate; it needs an independently reviewed correction and full rerun
before this candidate is merge-ready. No assertions were weakened here to hide it.

No full Windows unit suite, Windows/Linux Electron layout suite, signed installer, real campus
login, network-mode switch, installed-app replacement or public release was performed.
No GitHub Actions minutes or protection changes were requested. Local/native results do not
substitute for required CI or independent review.

## Synchronized source acceptance (2026-09-08)

- Dependency: `aeb691a389159a84fe8738448fdc5ee851c63c90` on PR #106.
- Review-branch synchronization: `262a4f2a00c8422c7e2f9256fb50e7c2a89878e9`.
- Verified code tree: `da43cfb040a1ee3e17a8c7f34941af194b99b97f`.

The review working branch incorporated its updated dependency without conflicts or rewriting
public commits. This did not merge either GitHub PR or change main. The category controller and
category E2E are byte-identical to the dependency, including later-page identity, pager focus and
open-dialog preservation. The diff against the new dependency remains the original module seam;
it does not duplicate the category behavior fixes as a new structural change.

Mac Electron category, full control-shell, schedule-navigation, ASAR module loading,
resource-manager, campus-workspace and popup-MFA fixtures all pass on the synchronized source.
The former control-shell 3-versus-5 failure is resolved by the dependency's exact-ID reachability
test and responsive behavior repair. The original failure above remains historical evidence.

5070 Linux full Desktop tests on the exact synchronization commit: 1272 pass / 6 platform skips /
0 fail under umask 022. Native Windows Node contracts: 36 pass; native Windows category and full
control-shell Electron fixtures pass using the same Git archive. Windows still emits GPU-process
exit warnings (34), so hardware acceleration is not certified. Architecture, exact-tree syntax
(473 sources), secret, install-script and governance checks pass.

The working branch is source-verified, but the PR stays a draft pending independent review,
required-check disposition and its base PR. No current Windows/Linux installer, full Windows unit
suite, signed/notarized application, real-school canary or public release is claimed. No Actions
dispatch or installed-app replacement was performed. Reverting only the extraction must preserve
the dependency's repaired category behavior and user data.

## Calendar stylesheet ownership (2026-09-08)

- Base: `a7004fcce12c2be4d1613b829e9518104acf5a22`.
- Extraction: `9421d7f61a85563e3a7a0e238c24388a2fd794e4`.
- Final comparison harness: `f254ba21c21ffeaf64ad62407f68d6525806e789`.
- Verified tree: `8f529c070fff2140497d808ae6d445a3b3aca4e7`.

The calendar's 173-line stylesheet is now feature-owned. Shared styles shrink from 2155 to 1981
lines. The parent grid placement and category-dialog centering remain shared. Existing calendar
declarations are unchanged; zero-specificity scoping prevents them from styling a sibling sentinel.
Refresh/loading rules are included rather than left behind in the global stylesheet.

The two new ownership tests initially failed on the absent module stylesheet. Both pass after
extraction. A live Electron A/B test switches between the exact base Git stylesheet and the new
stylesheets and compares every computed property and bounding rectangle in the calendar subtree.
Mac and native Windows pass all 5 week layouts, 4 dialogs and 3 refresh/loading states. An initial
loading-state comparison sampled different phases of the animated status dot; the harness now
pauses both samples at the same animation time and resumes afterwards. No tolerance was widened,
no property was excluded and no production animation or timeout was changed.

Mac and Windows style/design/Renderer Node contracts: 23 pass each. 5070 Linux full Desktop:
1274 pass / 6 platform skips / 0 fail. Native Windows category and full control-shell Electron
fixtures pass; GPU-process warnings (34) remain. Mac category, full control-shell, ASAR module
loading, resource-manager and campus-workspace fixtures also pass. Architecture, syntax (474
sources), secrets, install-script and governance gates pass. Native installers, Windows ASAR and
real-school behavior were not revalidated; the installed application and release assets are unchanged.

To repeat the A/B proof, set `HKUSTGZ_CALENDAR_CSS_BASELINE` to the exact base commit's exported
`desktop/renderer/styles.css` and run `electron e2e/schedule-navigation.electron.js`. Without that
option the ordinary fixture still checks feature isolation and the existing UI contracts, but does
not claim before/after computed-style equivalence. Baseline files stay in ignored test output.

## Calendar view ownership (2026-09-08)

- Base: `ae8516bf5ecfa434e13db70c5bedfe3222dd335b`.
- Code: `76a898fb17157fdcedb74fb73762e3218cfd1055`.
- Tested tree: `ddf34bc3ba904b7b5e60bdc4939459939da75067`.

The controller shrinks from 472 to 411 lines; a 71-line internal view owns the timetable markup.
Clock, translations, escaping, selected date/size, state/source markup and group publication are
explicit inputs. The controller still clears old detail bindings and owns cache, requests and
DOM effects. Public feature exports remain unchanged. Calendar algorithms, CSS, category controller,
IPC and persisted state are byte-identical to this phase's base.

Before extraction the new direct-view tests failed because the view entrypoint did not exist.
The completed tests verify escaped text, original immutable group bindings, seven-day empty/miniature
output and non-ready state delegation without clock access or detail-group publication. A fixed-clock
Mac comparison loaded the exact base feature from a Git archive and compared full schedule-body HTML
against this feature: all 40 combinations matched (ready/empty/loading/failed/session-expired,
360/440/960/1440 content widths, zh-CN/en). It used synthetic concurrent entries and cleared timers
after each render; this proves those rendering cases, not live-school behavior.

Mac focused contracts: 34 pass; native Windows same contracts: 34 pass. 5070 Linux full Desktop on
the exact commit: 1277 pass / 6 platform skips / 0 fail. Mac Electron schedule, module-ASAR, category,
full control-shell, resource-manager and campus-workspace fixtures pass. Native Windows schedule
and full control-shell fixtures pass; existing GPU warnings remain. Architecture, syntax (476
sources), staged secret, install-script and governance gates pass without budget changes.

No installer, real-school authentication, signing, release or installed-app changes occurred.
The view module is internal to this first feature; full Renderer registry/global-export enforcement
and other feature migrations remain separate M1 work. Revert this view-only commit to inline the
markup again without reverting the base's cache/category/dialog repairs.

## Extraction rollback

Revert the structural commit on its stated base. No persisted format or user data changes.
Temporary dependency links reuse the existing cache; removing a link does not remove that cache.
The unrelated root checkout and earlier candidates remain unchanged.

## Post-release synchronization — 2026-09-10

Source baseline: published main `39850415c901aeaa77ecb86cd3ce49a2e75290a8`.
Previous candidate: `14bac36e26770ebab6f637114340007833430e65`.
Tested integration tree before this documentation addendum:
`8eb011241c102144e91212f301548ade6c84609a`.

Seven merge conflicts were resolved locally without rewriting public history. Preserve main's
category resize-settling fixture; preserve feature imports, scoped styles, layout comparisons and
all initial/uncached-week cases in the structural candidate. The obsolete global facade stays
removed. Desktop lib, Rust, workflows, package manifest and lockfile match published main exactly.

Mac Node 24 full Desktop suite: 1,310 passed, 14 platform skips, zero failures (1,324 total).
Focused calendar/model/view/cache/style contracts: 26 passed. Architecture and install-script gates
passed. Native Electron schedule navigation passed date/week/today, refresh, details, keyboard,
minute geometry, overlap, narrow/wide/zoom and expiry recovery. The ASAR module fixture passed
seven-day rendering, absence of the old global and one authentication subscription.
Control-shell, resource-manager and campus-workspace Electron layout fixtures also passed.
Exact integration-tree JavaScript syntax passed for 482 files; repository governance passed.

The initial ASAR launch could not resolve a dependency through NODE_PATH; its owned process was
stopped, then an existing dependency cache was linked temporarily and the fixture passed. No
dependency installation or version change was performed. This environment failure is not a
successful first run or a production bug.

Windows/Linux native tests, installers, real-school authentication and live connection behavior
were not rerun for this integration tree. Earlier platform evidence remains historical. No PR
merge, remote push, release, Organization transfer, protection or installed-app change is claimed.

## Native-host follow-up — 2026-09-10

This follow-up supersedes only the platform omissions above that are explicitly covered here.
Exact code commit: `d8fdc451cfde9c9ed9f70ae408587282c7d1ae66`.

Linux on the designated 5070 WSL host reused the existing calendar Git checkout and dependency
cache. Git readback matched the exact commit. With Node v24.20.0 and umask 022, `node --test`
from `desktop` passed 1,310 tests, skipped 14 platform cases, and failed zero (1,324 total).
Repository-governance and architecture checks also passed. No dependencies were installed.

Windows used an isolated source-only snapshot under the existing calendar inspection directory.
Its Git-exported source tar SHA-256 was independently checked before extraction:
`31d00278e7099d556ae0c107579575f007ef50febb9b2bed0e6f3ad8e93a8305`.
Node v24.20.0 ran `calendar-view`, `campus-data-module`, `campus-data-styles`, `schedule-cache`
and `schedule-calendar` unit files: 26 passed, no failures or skips. The existing native Electron
runtime ran `e2e/schedule-navigation.electron.js`: PASS, including arbitrary weeks, refresh,
details, keyboard, minute geometry, overlap, narrow/wide/zoom and expiry recovery.
One GPU-process exit warning (code 34) occurred; clean hardware acceleration is not established.

The Windows full suite, Linux Electron layouts, cross-platform installers and real-school canaries
remain unverified for this commit. Mac evidence is in the preceding synchronization section.
No release, installation, Organization permission or repository-transfer operation was performed.
