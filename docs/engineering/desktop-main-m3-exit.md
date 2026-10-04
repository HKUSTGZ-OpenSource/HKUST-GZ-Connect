# Desktop Main M3 source exit receipt

- Status: Accepted source outcome; GitHub issue closure follows this receipt's checked documentation merge
- Owner: Desktop and architecture maintainers; accountable maintainer heeh02
- Last verified: 2026-10-04
- Applies to: `main@52479ca69c721133df9280eea6b314610eb44210`, not immutable v2.0.3 or an installed app
- Supersedes: numerical-only Main milestones and then-open statements in historical M3 slice records

## Source identity and decision

Accepted source tree: `0a875f95753d6a7bb4a3ed551f6b0dbbd64072bb`. Runtime sources match
the preceding accepted `5e6ce5a2aa8426e26a36448adcfd9874aec6d5b8` exactly; #239 changes only
support checker/contracts, module map/debt and documentation. Its head
`3a37de665702c5dae6fb03b71bb733eef3b60962` and accepted main have the same full tree.
All below results are observed source/fixture/platform evidence, not an inference from an empty
queue, a small file, a type, or real-school behavior. No remaining #81 requirement is deferred.

## Requirement-by-requirement acceptance

| #81 / canonical M3 requirement | Current proof |
| --- | --- |
| Main only constructs, injects, registers, binds lifecycle and starts | [Whole-root semantic boundary](../architecture/desktop-main-composition-boundary.md); AST audit of all 43 declared functions and five mutable top-level owner references; no second intent/generation/flight/timer/persistence authority |
| Residual settings and credential transactions move behind owners | `DesktopPersistenceRuntime` owns read/recovery/cache/transaction state; VPN/proxy access owners preserve protected/memory selection, sidecar and secret retirement. Main facades delegate, with source/unit/native Main/custom/switch/migration contracts |
| Connection orchestration moves behind owners | Actual FSM, `ConnectionOperationCoordinator`, Engine application/attempt/serving/termination owners; generation/intent/opaque-lease admission and initial offline choreography owned there. Duplicate clicks, stale work, stop/quit/clean drainage and queued startup regressions retained |
| Browser-open flow moves behind owners | `CampusBrowserManager.openWithFeedback` owns outer-await retirement and resource runtime owns ID-only transactions; actual Main/Browser/routing/context cases retain behavior. Full Browser decomposition remains separate M2 |
| Update orchestration moves behind owners | `UpdateNotificationRuntime` owns scheduling, checked link and terminal abort/flight retirement; actual Main quit fixture proves late results cannot read/write/notify/open retired resources |
| Profile/Account/Workspace, credentials, generation and migration ownership preserved | Real primary/custom controller/candidate cases, exact Profile switch recovery/relaunch, protected private files, migration/upgrade/resource-ID compatibility, memory-only identity and credential-owner contracts; no storage/schema/path/protocol migration introduced by M3 refactors |
| Three staged ratchets | Current 662 lines / 20 direct dependencies meets below-1200/30, below-800/24 and final 500-700/at-most-20. Effective35 and transitive170 remain explicit, not misreported as20. Downward caps never raised |
| Every extraction has public entrypoint and contract/facade | All20 current Main relative imports have zero private/undeclared module-map violations. #239 reconciles eight genuine service/adapter entrypoints; per-entry removal/private sibling/direction tests and an explicit no-legacy-bypass Main rule freeze zero. Compatible Main facades remain where caller contracts need them |
| No new Main-only algorithm, generic IPC or Renderer secret projection | Root semantic review distinguishes configuration/DTO/OS effects from owned algorithms. IPC remains trusted-sender/exact-channel/bounded suites. No new Preload/window export or secret projection; exact source/security and sandbox/MFA/strict-proxy checks remain |
| Desktop, Electron, persistence/upgrade, routing, Engine, Windows private files and packages pass | Exact main CI `37174025703`, attempt1, all9 jobs success; seven required contexts and three actual platform package jobs passed on #239's exact head before merge. Specific paths/steps are listed below |
| One-domain independently reviewable slices and decreasing metrics | Separate accepted M3 owner PRs retain rollback-compatible facades; final #237 lowers Main665->662, #238 retires last primary-ID policy gate1->0, #239 retires Main private imports8->0/global debt98->90 without runtime or dependency expansion |

## Concrete validation scope

[Exact main CI](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/actions/runs/37174025703)
has `desktop`, `desktop-electron`, `windows-private-file`, `engine`, `secret-scan`, package aggregator
and macOS/Windows/Linux package verifier jobs all completed/success, attempt1. The package
matrix builds shipped native binaries, constructs unpacked applications and verifies their exact
source/resources/native topology. It is not a signed/notarized distributed release assertion.

- Desktop runs full tests, architecture/governance, locked dependency/install audit, exact-tree
  syntax and shell-entry syntax. Local final suite: 1,993 tests, 1,977 passed, 16 platform skips,
  zero failed; skipped cases are not treated as Windows evidence.
- Electron runs actual Main integration/primary/custom/onboarding/Profile switch, Renderer
  recovery, synthetic Engine/network startup, upgrade/migration, Profile ASAR, toolbar/MFA/popup,
  strict proxy, responsive resource manager, Browser performance/soak, routing restart and idle gates.
- Windows runs its native private-file helper, legacy upgrade and packaged school discovery,
  actual Main callback/real FSM/opaque context/controller cases, current-user-only helper DACL
  and real ProxyCommand pipes. This does not promote all other stored file categories to DACL proof.
- Engine runs fmt/Clippy/tests for production and explicit laboratories, feature-gated process
  lifecycle, auth pipe, release-mode offline performance guards and shipped binary builds.
- Source architecture analysis observes 240 production files, Main20/35/170, no cycles/new layer
  violations and root debt0. Whole graph retains 90 exact static-JS legacy violations outside Main;
  M5 computed Renderer/Rust enforcement is still incomplete and inventory-only remains correct.

Exact-head PR CI `37173737968` and offline `37173738009` succeeded before the authorized squash.
Final native Main/Windows/package acceptance is from the separate exact-main run, not merely
copied local counters. See [#239 receipt](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/pull/239#issuecomment-5976223792)
for exact commands, red-to-green contracts, corrected local failures and source transport.

## Scope, authority and rollback

Maintainer-authorized convergence administrator merges followed checks without fabricating
independent reviews; HernanJiang review was requested, not received/claimed. Protections and
public tags remain unchanged. A terminal main-fetch timeout used an exact verified server-signed
Git object, CAS tracking update and normal fast-forward; no public history rewrite or proxy change.
Accepted owned worktrees are recoverably archived only after no-handle/clean/owned-symlink
verification. Shared dependencies, user data, installed applications and unmerged history remain.

This is M3 source acceptance only. Published stable remains immutable
`v2.0.3@b57c394c73e0b07a0076e26f58e1666e29f00135`; these post-tag changes are not injected into
that release or the installed app. No live-school/real-credential canary is claimed. Original
#127/#177 reports, M1/#79, M2/#80, M5/#83, deferred G4/#84 and the full #60 goal remain separate.

Owner slices are independently revertible with their contracts/downward ratchets; map/checker/
debt/docs must roll back together. No user-data migration is needed. Reverting fixed lifecycle
guards can restore known stale-work risks, so rollback is not a claim those bugs remain safe.
Future Main changes still require the same domain, public-entrypoint, ownership and exact-source
gates; accepting this wave does not waive them or authorize release/testing beyond its scope.
