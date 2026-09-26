# Modularization plan

- Status: Active execution plan; M4 completed, M1/M2/M3/M5 open
- Owner: architecture maintainers
- Last verified: 2026-09-27 (`main@5cec683c4bdcb3e6663572943d8799f6eccb79b3`)
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

At the verification commit, Renderer `app.js` is 562 lines, Campus Browser 1,502,
Desktop Main 1,604 and `ec-engine.rs` 498. M4/#82 is closed through #148; the other
four waves remain open. Counts are debt evidence, not a substitute for ownership/lifecycle gates.

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

The [feature host](renderer-feature-host.md) and separate lifecycle slices now mount campus-data,
official-favorites, interactive-auth and Integration Center from explicit entrypoints (#108–#120).
The [static Renderer policy](renderer-boundaries.md) in #110 rejects new legacy exports and invalid
HTML/module edges; [localization ownership](renderer-localization.md) entered in #116. The
[auth lifecycle](renderer-auth-challenge-lifecycle.md), [Integration Center lifecycle](integration-renderer-lifecycle.md)
and [Main export-intent repair](integration-export-intents.md) also entered `main`. Their original
candidate SHAs in linked review records are historical; none is part of published 2.0.2. The
remaining `app.js` composition and legacy global/HTML-order debt prevent closing M1 merely because
these slices passed CI. The host must not mask missing owner cleanup with a no-op.

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
not a completion claim for all Browser owners. The current-base candidate reduces the remaining
Browser orchestrator from 1,804 to 1,627 lines; its tab owner is 397 lines, below the 600-line
per-owner ceiling.

[Workspace ownership](browser-workspace-owner.md) moves Browser-facing workspace and favorite
projection/effects into the existing Workspace module, keeping its sandbox protocol unchanged.

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

Exit target: no Browser owner exceeds 600 lines and lifecycle tests cover every extracted teardown.

## Wave M3 — Desktop Main composition

[Update notification ownership](update-notification-owner.md) keeps scheduling and
notification state in the existing update domain, lowering Main to 1,682 lines
without increasing dependency caps. This is one bounded seam, not M3 completion.

[Engine serving ownership](desktop-engine-serving-owner.md) places readiness and
Browser activation in the existing runtime, lowering Main further to 1,604 lines
without moving process creation, credentials or termination into this slice.

Move remaining settings/credential transaction, connection start/stop, browser-open and update
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

- Move remaining root Desktop tests into `test/unit/<domain>`, `test/contracts` or
  `test/integrations`; reject new root-test debt.
- Validate `module-map.yml` path coverage and public entrypoints.
- Add dependency checks for Renderer globals/ES modules and Rust visibility.
- Keep stable required GitHub status contexts even when internal jobs are reorganized.

## Rollback

Each wave is independently revertible. Do not merge a wave that requires another unmerged branch to
restore startup, upgrade or package behavior. Compatibility facades remain until both old and new
paths have equivalent tests on the same commit.
