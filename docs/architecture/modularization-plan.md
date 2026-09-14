# Modularization plan

- Status: Proposed execution plan
- Owner: architecture maintainers
- Last verified: 2026-09-04
- Applies to: post-2.0.0 `main`
- Supersedes: ad-hoc file-by-file extraction without an ownership receipt

## Purpose

Reduce merge conflicts and accidental cross-feature regressions while preserving the shipped
behavior, secret boundaries and upgrade compatibility of 2.0.0. Directory movement is not a goal;
independent ownership, lifecycle and public contracts are.

## Baseline

The Desktop architecture gate passes with no detected CommonJS cycle, but its ratchets are nearly
exhausted: Main has 36 direct dependencies, 170 transitive dependencies and 1,719 lines; the control
Renderer has 563 lines. The gate cannot see the main Renderer page's ordered global-script graph.

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

The proposed [feature host](renderer-feature-host.md) now covers campus-data and official-favorites
through separate lifecycle review units. Remaining owners require reviewed start/dispose contracts;
the catalog must not silently wrap missing cleanup with a no-op.

The proposed [campus-data boundary](campus-data-module.md) and
[official favorites boundary](official-favorites-module.md) establish the first two explicit
native entrypoints in separate stacked review candidates. Their local/native evidence does not
complete the registry, global-export enforcement, localization or release gates below.

The proposed [static Renderer policy](renderer-boundaries.md) separately adds frozen-export and
public-entrypoint checks to the architecture command. It is not the runtime lifecycle registry
and does not replace independent review or claim remote CI has executed.

The proposed [localization boundary](renderer-localization.md) splits the two control/chrome
locale dictionaries into domain owners with duplicate and missing-key tests. Its temporary
compatibility facade does not complete the removal of legacy HTML-order coupling.

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

- Move remaining root Desktop tests into `test/unit/<domain>`, `test/contracts` or
  `test/integrations`; reject new root-test debt.
- Validate `module-map.yml` path coverage and public entrypoints.
- Add dependency checks for Renderer globals/ES modules and Rust visibility.
- Keep stable required GitHub status contexts even when internal jobs are reorganized.

## Rollback

Each wave is independently revertible. Do not merge a wave that requires another unmerged branch to
restore startup, upgrade or package behavior. Compatibility facades remain until both old and new
paths have equivalent tests on the same commit.
