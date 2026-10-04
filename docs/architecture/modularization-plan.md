# Modularization plan

- Status: Active execution plan; M3/M4 source outcomes completed, M1/M2/M5 open
- Owner: architecture maintainers
- Last verified: 2026-10-04 (`main@52479ca69c721133df9280eea6b314610eb44210`)
- Applies to: development `main` after published 2.0.3; merged source is not a new release
- Supersedes: ad-hoc file-by-file extraction without an ownership receipt

## Purpose

Reduce merge conflicts and accidental cross-feature regressions while preserving the shipped
behavior, secret boundaries and upgrade compatibility of 2.0.0. Directory movement is not a goal;
independent ownership, lifecycle and public contracts are.

## Baseline

The following is the 2026-09-04 baseline, not a claim about current file sizes. The Desktop
architecture gate passed with no detected CommonJS cycle, but its ratchets were nearly
exhausted: Main has 36 direct dependencies, 170 transitive dependencies and 1,719 lines; the control
Renderer has 563 lines. At that baseline, the gate could not see the main Renderer page's ordered
global-script graph; #110 later added a static boundary policy for new changes.

At the verification commit, Renderer `app.js` is 420 lines, Campus Browser 1,122,
Desktop Main 662 (20 direct / 35 effective / 170 transitive dependencies) and
`ec-engine.rs` 498. M3's [whole-root receipt](../engineering/desktop-main-m3-exit.md)
accepts its source outcome; M4/#82 is closed through #148. M1/M2/M5 remain open.
Counts are debt evidence, not a substitute for ownership/lifecycle gates.
Per-wave size counts below are historical extraction receipts, not competing current totals.
All three M3 numerical stages and semantic/platform criteria are met at the receipt checkpoint.
Current static-JS debt inventory/cap is 90 and the frozen legacy Renderer list has 24 files.

Primary concurrency hot spots:

| Hot spot | Baseline | Problem |
| --- | ---: | --- |
| `independent/src/bin/ec-engine.rs` | 2,485 lines | Process composition, state/control and cleanup share one file |
| `desktop/renderer/styles.css` | 2,096 lines | Multiple features share broad selectors and responsive overrides |
| `desktop/lib/browser/session/campus-browser.js` | 1,854 lines | Window, tabs, route, certificate, credential/MFA, download and workspace ownership |
| `desktop/main.js` | 1,719 lines | Composition plus residual lifecycle/transaction behavior |
| `desktop/renderer/i18n.js` | 1,500 lines | All locales and features share one conflict-prone table |
| `independent/src/engine/socks.rs` | 1,570 lines | Frontend protocol, lifecycle and implementation details remain coupled |

## Rules for every wave

- One domain, one PR, no intended product behavior change unless separately approved.
- Capture the observable contract before moving ownership.
- Add the new public entrypoint and tests before removing the old path.
- Keep a compatibility facade only when current callers cannot migrate atomically; ratchet it to zero.
- Do not increase architecture, timeout, file-size or performance budgets.
- Lower at least one relevant debt metric in every extraction PR.
- Run upgrade, security and package gates when the moved boundary touches persisted state, secrets,
  routing, Browser sessions or shipped native resources.

## Wave M1 — Renderer dependency authority

[Connection overview ownership](renderer-connection-overview-owner.md) migrates the
existing metrics/underlay presentation into the native host with terminal listener,
timer and asynchronous-result cleanup. It removes one legacy global/script exception
without changing connection authority or completing the remaining M1 bootstrap work.

The [feature host](renderer-feature-host.md) and separate lifecycle slices now mount campus-data,
official-favorites, interactive-auth and Integration Center from explicit entrypoints (#108–#120).
The merged #187 [Control Tower form owner](renderer-control-tower-owner.md) moves the bounded advanced
settings form/apply and feedback lifecycle out of the Renderer bootstrap without changing its
markup or immediate proxy-auth migration owner. It is one M1 slice, not bootstrap completion.
The [static Renderer policy](renderer-boundaries.md) in #110 rejects new legacy exports and invalid
HTML/module edges; [localization ownership](renderer-localization.md) entered in #116. The
[auth lifecycle](renderer-auth-challenge-lifecycle.md), [Integration Center lifecycle](integration-renderer-lifecycle.md)
and [Main export-intent repair](integration-export-intents.md) also entered `main`. Their original
candidate SHAs in linked review records are historical; none is part of published 2.0.2. The
remaining `app.js` composition and legacy global/HTML-order debt prevent closing M1 merely because
these slices passed CI. The host must not mask missing owner cleanup with a no-op.

The merged #196 [Notifications and Help owner](renderer-notifications-owner.md) retires two classic
HTML scripts and their two frozen `window.*` exports in favor of one explicit feature-host
entrypoint. It keeps the existing drawer, diagnostics, focus trap and Reduced Motion behavior;
other legacy script-order and bootstrap responsibilities keep M1 open.

The merged #213 [new-tab settings owner](renderer-new-tab-settings-owner.md) removes one classic
HTML script and global exception in favor of the native feature host with exact listener and
late-result retirement. IDs, shared styling and Main save authority stay unchanged. This is
global/dependency debt reduction, not a claim that `app.js` becomes smaller or M1 is complete.

The merged #214 [browser-data settings owner](renderer-browser-data-settings-owner.md) retires
one further classic script/global with two-click confirmation and language cancellation
unchanged. The native host owns exact listener cleanup and late presentation retirement;
Main still owns the submitted clear. This does not add a clear policy or close M1.

1. Add an explicit Renderer bootstrap and a checked feature registry.
2. Freeze the list of existing `window.*` feature exports; CI rejects new ones.
3. Give each feature one public entrypoint with injected dependencies.
4. Move feature-specific CSS beneath a feature root class.
5. Split localization by locale and feature with a duplicate/missing-key check.
6. Migrate one feature at a time, beginning with timetable/favorites before shared connection state.

Exit:

- HTML does not determine hidden feature dependency order;
- no new global feature symbol is needed;
- GUI evidence covers narrow, standard, wide, keyboard and reduced motion;
- `app.js` is a bootstrap rather than a feature implementation.

## Wave M2 — Campus Browser ownership

The [download owner](browser-download-owner.md) from #112 and its
[native timing/context retirement](../engineering/native-browser-downloads.md) from #113 are
merged source; #111 hardened the popup MFA fixture. This is not a released or live-school Browser
acceptance result.

The first tab-view ownership boundary is documented in
[Browser tab lifecycle owner](browser-tab-lifecycle.md). It is a separately reviewable extraction,
not a completion claim for all Browser owners. That historical #142 extraction reduced the
Browser orchestrator from 1,804 to 1,627 lines; its tab owner was 397 lines, below the 600-line
per-owner ceiling.

[Workspace ownership](browser-workspace-owner.md) moves Browser-facing workspace and favorite
projection/effects into the existing Workspace module, keeping its sandbox protocol unchanged.

The merged #161 [Campus Browser window owner](browser-window-owner.md) isolates the chrome window's
creation, toolbar event binding and close confirmation in the existing Browser manager module,
without adding a production dependency node or changing credential-popup ownership.

The merged #186 [Browser toolbar owner](browser-toolbar-owner.md) moves toolbar state projection,
coalesced updates and teardown cancellation out of the Browser orchestrator. It is based on the
merged #185 certificate entrypoint and is not a full M2 completion or a released Browser change.

The merged #192 [Browser navigation owner](browser-navigation-owner.md) gives tab-bound intent, Home,
New Tab, address navigation and reload to a distinct class co-located with the existing tab
lifecycle module. The Browser orchestrator falls from 1,437 to 1,368 lines; the tab file remains
below 600 and the transitive dependency budget remains unchanged. M2 is still open.

The [route presentation follow-on](browser-route-presentation-owner.md) moves current URL,
effective navigation-route selection and tab route refresh into that same owner. The Browser root
falls further to 1,333 lines, the co-located owner file remains below 600 and the Routing policy
and dependency budget stay unchanged. M2 is not complete.

The merged #194 [managed credential popup owner](browser-managed-popup-owner.md) moves native MFA
child-window construction, event wiring and idempotent close out of the Browser orchestrator.
The Browser root falls to 1,236 lines; the separate owner class shares the existing 492-line
credential module, below 600, without changing Session or credential-flow authority. M2 remains
open for the remaining event and routing lifecycle responsibilities.

The [toolbar command owner](browser-toolbar-command-owner.md) moves validated toolbar actions
and native keyboard shortcut dispatch into the existing Toolbar module. Browser root falls to
1,137 lines; Toolbar is 262 lines and Main dependencies do not grow. Page events and routing
activation still need separate M2 ownership work.

The merged #209 [routing activation owner](browser-routing-activation-owner.md) moves the Browser's
readiness admission and single-flight configure/resume record beside the existing Session owner.
PAC/request-gate authority and route semantics stay unchanged; window cleanup resets only the
coordination record. This adds no production dependency node and does not complete page-event
ownership or the other M2 acceptance gates.

Extract tested owners for:

```text
window lifecycle
tab/session lifecycle
navigation and history
routing activation/gate
certificate decisions
credential/login flow
managed MFA popup
downloads
toolbar presentation
workspace home
```

`CampusBrowserRuntime` composes these owners. It does not retain their algorithms. The popup owner
must preserve shared Session cookies, opener messaging, explicit close and the no-OTP-storage rule.

The [viewport owner contract](browser-viewport-owner.md) separates resize scheduling, native page
bounds and per-window find state behind the existing toolbar module. Its local candidate lowers
Browser 1,122->1,094 without adding a production graph node; exact-head acceptance is still required.
Page/document and credential command ownership remain open, so this slice is not M2 completion.

Exit target: no Browser owner exceeds 600 lines and lifecycle tests cover every extracted teardown.

The [page presentation owner](browser-page-presentation-owner.md) isolates page listeners,
slow-load/failure/crash presentation and late observation effects beside the existing chrome owners.
It keeps routing and credential algorithms behind their original ports, lowering Browser1094->968
without a new production dependency node. Credential-command and remaining composition ownership
still require separate M2 acceptance; a local source candidate is not a release or complete wave.

The [credential command owner](browser-credential-command-owner.md) isolates saved-account
commands and approved shared-login delivery, binding original page/window/origin before asynchronous
effects and retiring temporary projections on page/tab/window changes. Its source candidate lowers
Browser968->921 without a new production node; original credential/MFA controller bodies and vault
schema are unchanged. Candidate-saving lifetime and remaining composition still need M2 review.

The [credential save lifetime](browser-credential-save-lifetime.md) binds existing save approval
to original window/tab/context and storage identity, retaining login/MFA evidence and explicit
consent. Source candidate921->919 retires old approvals and candidate timers without a new node;
native retirement and existing MFA gates remain required. Remaining Browser composition is still M2.

## Wave M3 — Desktop Main composition

Completed source outcome, with every #81 criterion mapped to concrete owner/test/platform
evidence in the [exit receipt](../engineering/desktop-main-m3-exit.md) and the
[composition boundary](desktop-main-composition-boundary.md). #239 removes the final eight
Main private-import exceptions and forbids matching legacy records from bypassing Main.
The paragraphs below are historical slice receipts: their then-open statements and sizes
describe those checkpoints, not current gates or incomplete work after the exit receipt.

[Update notification ownership](update-notification-owner.md) keeps scheduling and
notification state in the existing update domain, lowering Main to 1,682 lines
without increasing dependency caps. This is one bounded seam, not M3 completion.

[Engine serving ownership](desktop-engine-serving-owner.md) places readiness and
Browser activation in the existing runtime, lowering Main further to 1,604 lines
without moving process creation, credentials or termination into this slice.

[Engine termination ownership](desktop-engine-termination-owner.md) isolates exit/close,
serving revocation and retry effects in the existing runtime; Main falls to 1,509 lines.
Process creation, persistence and the final M3 dependency target remain separate work.

[Engine attempt ownership](desktop-engine-attempt-owner.md) moves the complete startup
attempt into the existing process module, retaining the current credential selector
and callback fences. Main falls to 1,247 lines/35 direct dependencies; M3 remains open.

[Connection operation ownership](desktop-connection-operation-owner.md) moves pending
connect/stop/reconnect records and quit/post-stop admission to the existing state
entrypoint. Main falls to 1,136 lines/34 dependencies; M3's dependency targets remain open.

[Persistence read ownership](desktop-persistence-read-owner.md) moves legacy file
adaptation and settings-read feedback into the existing Runtime. Main falls to
1,084 lines/33 dependencies; journal recovery and final M3 targets remain separate.

[Credential transaction ownership](desktop-credential-transaction-owner.md) moves
legacy journal recovery, its blocked/retry state, mutation dispatch and recovery
feedback into that same Runtime. At that historical slice Main falls to 1,008 lines,
32 direct / 46 effective dependencies, with 170 transitive dependencies unchanged.
The first-stage dependency target was still open at that slice. Later #212 reaches the
intermediate below-800/24 stage; the then-730-line/24-dependency root remained above final composition.

The follow-on connectivity-operation seam extends the existing
[Connection operation owner](desktop-connection-operation-owner.md) with recovery
admission, invalidation and restart; `ConnectivityRecovery` retains outage epochs
and scheduling. After the storage-effects rebase, Main is 950 lines and the
existing state entrypoint is 541; 32 direct / 46 effective / 170 transitive
dependencies are unchanged. M3 remains open: this does not reach the below-800/24
intermediate or 500–700/20 final target.

The merged #184 [Routing policy coordinator](desktop-routing-policy-coordinator.md) moves derived
PAC publication and rule commit/restore bundles into the existing Routing entrypoint. Main
falls to 896 lines / 31 direct / 45 effective / 170 transitive dependencies; M3 remains open.

The merged #188 [proxy access owner](desktop-proxy-access-owner.md) keeps the stable local-proxy secret,
per-Engine copy, owner-only helper sidecar and generation-bound retirement in the existing
Persistence credential entrypoint. Main falls from 895 to 864 lines without a new production
module or expanded dependency budget. It remains above the next M3 size/dependency targets.

The merged #189 [settings transaction owner](desktop-settings-transaction-owner.md) moves the
cached route-settings snapshot and the close-action commit/rollback factory into the existing
Persistence Runtime. Main falls from 864 to 845 lines; dependency metrics remain stable. This is
merged source, not the below-800/24 intermediate gate.

The merged #190 [Browser readiness owner](desktop-browser-readiness-owner.md) returns the two
intent-bound Browser connection wait outcomes to the existing Connection operation entrypoint.
Main falls from 845 to 831 lines; the reviewed 75-second deadline and dependency budgets stay
unchanged. Browser launch/routing behavior and the later M3 targets remain separate.

The merged #191 [Resource library owner](desktop-resource-open-owner.md) moves Profile-backed
resource source adaptation and ID-only open transactions into the existing Resources runtime.
Main falls from 831 to 819 lines without a new dependency node or changed route authority.
The next M3 size and dependency targets remain open.

The merged #210 [VPN credential access owner](desktop-vpn-credential-access-owner.md) places
presence checks, process-memory selection, revision-scoped clearing and canonical validation
behind the existing Persistence public runtime. Main falls to 800 lines / 27 direct dependencies;
three private-import exceptions retire and the debt ceiling drops to 110. Existing protected
storage priority, Profile binding and zeroization remain unchanged; M3 is not complete.

The merged #211 [Browser request-security boundary](browser-request-security-boundary.md) moves
application certificate/proxy challenge dispatch through the existing Browser Manager entrypoint.
Main keeps event registration and falls to 776 lines / 26 direct dependencies; actual consent,
proxy credentials and their teardown remain separate owners. No new policy, public import-debt
exception or global network behavior is added; M3's 24-dependency/final targets remain open.

The merged #212 [proxy access composition](desktop-proxy-access-composition.md) constructs the
unchanged encrypted store and generation/sidecar owner through the Persistence public entrypoint.
Main falls to 767 lines / 24 direct dependencies and private-edge debt to 108. Those merged-slice
metrics meet the intermediate below-800/24 stage, not final 500-700/20 composition or M5 acceptance.

The merged #215 [ready-startup sequence](desktop-ready-startup-owner.md) moves ordered
Profile/storage recovery, startup presentation and service admission into the existing App
startup module. Obsolete composition bindings retire; Main falls to 730 lines while
24 direct/170 transitive dependencies remain. Exact downward budgets and three private-edge
retirements are enforced; final 500–700/20 composition is still outstanding.

The proposed [Engine application assembly](desktop-engine-application-composition.md) constructs
the existing process/control owners through one Connection entrypoint and preserves their shared
identity. Main falls to 723 lines/21 direct imports with no new production node, while three
private-edge exceptions retire. The final 500–700/20 target and full dependency enforcement remain open.

The proposed [trusted Control registrar](desktop-trusted-control-registrar.md) moves the Main-only
registration closure behind the existing IPC suite while delegating unchanged sender/frame/file
checks. Main reaches 20 direct imports at 720 lines; one private-edge exception retires. The
500–700-line final composition outcome and full M5 remain outstanding.

The proposed [Connection status owner](desktop-connection-status-owner.md) moves
the display record, connection timestamp and status/log/recovery effects into the
existing presentation module, preserving the FSM's authority. Main reaches 699
lines/20 direct imports without a new production module or graph edge. Numeric
targets alone do not finish the residual composition/ownership acceptance.

The proposed [Browser command feedback owner](browser-open-feedback-owner.md)
closes the outer-await retirement gap independently reproduced in #222. Main
delegates the user-command flow to the existing Manager epoch without altering
resource-open, routing or login policy. Main reaches 689 lines with graph metrics
unchanged; this does not finish the other M2/M3 ownership outcomes.

The proposed [credential presentation/startup boundary](desktop-credential-presentation-startup.md)
puts the remaining login DTO and startup sidecar effects behind existing Persistence
owners, without changing data/schema or removal policy. Main reaches 674 lines with
20 direct imports; locale, recovery-notice and resource-feed ownership still require
semantic review rather than closing M3 from the numerical milestone.

The proposed [Desktop locale owner](desktop-locale-owner.md) removes Main's locale/
translator authority into the existing Platform i18n file, preserving primitive
selection, startup recovery and presentation order. Main reaches 669 lines/20 direct
imports; three old private edges retire (inventory/cap 98). Recovery-notice and
resource-feed authority still require semantic M3 review.

Move remaining settings-surface coordination, connection start/stop, browser-open and update
orchestration behind existing domain services. Main should perform:

```text
construct runtimes
inject effects
register IPC suites
bind application lifecycle
start
```

Ratchet stages:

- Main below 1,200 lines and 30 direct dependencies;
- below 800 lines and 24 direct dependencies;
- final target 500–700 lines and at most 20 direct dependencies.

## Wave M4 — Rust Engine composition

The first binary-private startup seam is documented in
[Engine argument ownership](engine-argument-owner.md). It does not export a new library API or
complete the runtime orchestration work below.

The [process ownership receipt](engine-process-ownership.md) covers the private control, event,
operation, startup, serving and failure owners together. Merged #148 retains
pre-password Gateway classification and reduces the root to 498 lines without adding public
process APIs. Its three build modes, lifecycle, protocol, native, performance and package
acceptance closed #82. These remain mandatory gates for future changes; size alone is not acceptance.
The default-production compiler boundary for research tools is defined in
[ADR-0034](../adr/0034-compatibility-laboratory-feature-boundary.md). Laboratory opt-in retains
separate coverage; this boundary does not replace platform/package verification.

First reorganize inside the current crate:

```text
app/             process orchestration, lifecycle and shutdown
auth/            transactions, challenge control and authenticated session
gateway/         HTTP, connector and verified gateway adapters
transport/       Modern/TLS/data-plane acquisition
network/         netstack, DNS and proxy frontends
compatibility/   probes, observation and clean-room tools
protocol/        stable wire/config/error contracts
bin/             argument parsing and composition only
```

Narrow modules to `pub(crate)` unless they are intentional library contracts. Replace source-string
boundary checks incrementally with visibility/compiler-enforced boundaries. Split Cargo crates only
after the in-crate public contracts stabilize and a measured build/ownership need exists.

Exit target: `ec-engine.rs` below 800 lines; production code cannot import compatibility modules;
all existing wire, fixture, performance and package gates remain green.

## Wave M5 — Tests and repository contracts

The schema-2 path/entrypoint subset is defined in
[module map coverage](module-map-enforcement.md). Dependency enforcement and Rust visibility are
explicitly not promoted to complete by this coverage check.
The static-JS ratchet now rejects new resolved cross-module bypasses against 124 exact legacy
edges at `main@381c5f29`. Declaring the existing shared campus-route contract public reduces
the inventory to 116. Merged #184 Routing coordination lowers it to 115 and #185 certificate
entrypoint to 113, without new public policy or budget expansion. Later #210/#212/#215 lower
the inventory/hard cap to 105, then locale/entrypoint reconciliation lowers it to 90.
Main's zero-exception subset is enforced, not full M5. Dynamic Renderer and Rust visibility remain separate work.

- Root Desktop test debt is zero; keep tests in `test/unit/<domain>`, `test/contracts` or
  `test/integrations` and reject new root-test debt.
- Validate `module-map.yml` path coverage and public entrypoints.
- Add dependency checks for Renderer globals/ES modules and Rust visibility.
- Keep stable required GitHub status contexts even when internal jobs are reorganized.

## Rollback

Each wave is independently revertible. Do not merge a wave that requires another unmerged branch to
restore startup, upgrade or package behavior. Compatibility facades remain until both old and new
paths have equivalent tests on the same commit.
