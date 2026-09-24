# Open-source collaboration convergence goal

- Status: Active
- Authority: project maintainer
- Baseline: `main@15738338ff2a280300b66e98a1823659f24630a4`
- Started: 2026-09-04
- Last verified: 2026-09-25 (before this documentation PR)
- Development main at verification: `6f960af57466e6551a5e347ecc26ae9b902f69d9`
- Scope: repository governance, documentation truth, agent instructions, module boundaries,
  contributor workflow, GitHub protections and organization migration

## Objective

Make HKUST(GZ) Connect safe and understandable for sustained open-source development by
multiple people and multiple coding agents, without weakening the credential, MFA, routing,
upgrade or release boundaries already shipped in 2.0.0.

The result must make ownership, authority, scope, validation and release provenance explicit.
`AGENTS.md` guides agents, repository documents guide people, and CI/GitHub settings enforce the
high-risk rules. No instruction file is treated as a substitute for review or technical controls.

## Non-negotiable boundaries

- Real passwords, OTPs, cookies, tokens, private keys and unsanitized school evidence never enter
  Git, issues, pull requests, agent prompts, logs or CI artifacts.
- Real-school investigation remains read-only and user-authenticated unless a maintainer approves
  a bounded canary with sanitized evidence.
- Unknown authentication, routing and protocol behavior fails closed.
- Renderer, Preload, Desktop Main and Rust Engine retain the dependency and secret boundaries in
  `ARCHITECTURE.md`.
- Public release tags are immutable and releases remain bound to one exact commit and verified
  cross-platform artifacts.
- User data and installed application state are outside repository-governance migrations.

## Current findings

1. PR #59 established the contributor, agent, documentation and machine-governance baseline on
   `main`; runtime modularization must now consume those boundaries rather than create alternatives.
2. `desktop/main.js`, `desktop/lib/browser/session/campus-browser.js`, the Renderer bootstrap/CSS,
   and `independent/src/bin/ec-engine.rs` are concurrency hot spots.
3. Renderer feature files still depend on global `window.*` names and HTML script order that the
   CommonJS architecture graph cannot see.
4. Stable `v2.0.2` is published from `main@39850415c901aeaa77ecb86cd3ce49a2e75290a8`.
   PRs #88, #95, #106 and #107 are merged. Four platform installers, a build receipt and SHA-256
   manifest are uploaded. The repository-ID updater is shipped; the historical 2.0.1 bridge
   requirement is satisfied. Published packages and the currently installed Mac candidate are
   distinct evidence, not interchangeable versions.
5. Repository Rulesets, CODEOWNERS, templates, Dependabot, release Environment and immutable Action
   policies are active. Two Organization owners are present. Protected `main` still requires one
   approval and seven strict checks; the maintainer authorized one-time administrator squash merges
   for the current convergence queue after its exact-head checks, without changing that protection.
   Team ownership and post-transfer security settings remain incomplete.
6. The original repository transferred to `HKUSTGZ-OpenSource` on 2026-09-12 with explicit maintainer
   authorization. Organization default permission is now `read`. Repository ID, main, tags,
   releases/assets and PR heads/bases are preserved. Existing Organization Owner `HernanJiang`
   inherits admin alongside `heeh02`; no membership was created. Ownership transfer is complete,
   while team/reviewer and post-transfer governance convergence remain open. See the
   [migration receipt](docs/governance/2026-09-12-organization-transfer-receipt.md).

## Completion outcomes

### G0 — Restore repository truth

- `docs/README.md` defines the documentation map and authority order.
- Current status, roadmap, product definition, ADR index and 2.0.0 release notes agree with the
  published stable release.
- Tool-specific historical material such as `docs/superpowers/` is removed from the maintained
  tree; Git history remains the recovery record.
- Historical plans and audits are clearly non-authoritative.

### G1 — Establish contributor and agent contracts

- Root and scoped `AGENTS.md` files cover repository, GitHub, Desktop, Renderer, Rust and docs.
- `CONTRIBUTING.md`, root `SECURITY.md`, `CODE_OF_CONDUCT.md`, PR/Issue templates and CODEOWNERS
  exist and agree with the architecture.
- AI-assisted work records scope, evidence and accountable reviewer without storing raw prompts or
  secrets.
- One issue, one owner, one branch and one isolated worktree is the default concurrency model.

### G2 — Enforce file and module ownership

- A machine-readable module map identifies owned paths, public entrypoints, allowed dependencies,
  risk class and required validation.
- Repository checks reject missing governance files, forbidden generated/private paths and new
  tool-specific canonical-document directories.
- Tests mirror production domains; new root-level test debt is forbidden.
- Architecture budgets ratchet downward as hot spots are extracted; budgets are never raised to
  make unrelated feature work pass.

### G3 — Reduce concurrency hot spots

- Renderer stops adding global feature symbols and moves behind one explicit bootstrap/public API
  per feature.
- Campus Browser separates window, tab, navigation, routing, credential/MFA, download and workspace
  ownership.
- Desktop Main becomes a composition root rather than a lifecycle implementation hub.
- Rust Engine moves process orchestration out of `src/bin/ec-engine.rs`, narrows public visibility
  and keeps compatibility laboratories outside production paths.
- Every refactor wave preserves observable behavior and lands as a separately reviewable PR.

### G4 — Harden GitHub and migrate ownership

- The repository is transferred to the maintainer-selected GitHub Organization.
- Organization teams separate maintainers, Engine, Desktop/UI, Security and Release ownership.
- Main and `v*` tags are protected by Rulesets; release tags cannot be updated or deleted.
- Ordinary changes use squash merge and merged branches are deleted automatically.
- CODEOWNERS review and last-push approval are enabled after a second trusted reviewer exists.
- GitHub Actions require immutable full-SHA references and least privilege.
- Dependabot alerts/security updates and grouped npm, Cargo and Actions updates are enabled.
- A migration receipt verifies redirects/remotes, permissions, branch/tag rules, secrets,
  environments, Actions, releases and the installed update URL after transfer.

## Delivery sequence

1. Reconcile published release truth and capture the minimal transfer preflight.
2. Confirm the destination permission decision and bounded transfer authorization, then transfer
   the existing repository without renaming, recreating or republishing it.
3. Verify repository identity, redirects, releases, update discovery and effective protections.
4. In the Organization, converge governance through the existing PR and review existing module
   stacks in dependency order, rather than opening more speculative branches.
5. Complete Renderer, Browser, Desktop Main and Rust modularization in bounded waves.
6. Finish cross-platform, upgrade, security and governance acceptance; clean only proven redundant
   generated artifacts/worktrees after preserving unmerged work and shared dependencies.

This transfer-first sequence does not require M1–M5 completion, an empty PR queue, replacement of
the maintainer's running Mac app, or creation of every future team. Those are separate outcomes.
Missing independent reviewers still block ordinary protected merges, not repository transfer.
Execution correction: freeze new decomposition branches/PRs until the existing queue is reviewed;
allow at most two active code lanes, with one merge-ready PR per lane. Pending migration decisions
must not become a reason to accumulate speculative refactors or repeat unchanged full-suite runs.
The transfer procedure records this bounded convergence cycle; no additional parallel goal is needed.
See the [proposed transfer-first convergence plan](docs/governance/2026-09-10-transfer-first-plan.md)
for the current PR dependency lanes, minimum migration checks and bounded worktree cleanup rules.

## Pull-request boundaries

- Governance and documentation changes do not contain runtime behavior changes.
- Each modularization PR owns one domain and one independently reviewable outcome.
- GUI, protocol, persistence migration, CI and release changes are not combined in one PR.
- A PR records exact base/final SHA, owned paths, tests run, tests omitted, risks and rollback.
- Stacked PRs require an explicit dependency chain; otherwise every PR targets `main`.

## Goal completion gate

The goal is complete only when:

1. all G0–G4 outcomes are implemented or explicitly accepted as deferred with an owner and trigger;
2. the new GitHub owner, default branch, release tags, protections and latest Release are read back;
3. required CI passes on the exact final `main` commit;
4. module-boundary and repository-governance checks pass locally and in CI;
5. documentation has one current source of truth and no active statement points to a merged branch;
6. no secrets, generated packages, raw captures or vendor binaries entered the Git tree;
7. unresolved risks and organization-level settings are recorded in a final governance receipt.

## Historical progress receipt — 2026-09-04

This receipt describes the earlier plan. Current findings above supersede its destination and
release assumptions.

- G0 merged through PR #59: current release truth is aligned; obsolete tool-specific documents and
  completed product proposals are removed; original 2.0 vision documents are classified under
  `docs/archive/`.
- G1 merged through PR #59: six-level agent instructions, contribution/security/conduct policies,
  CODEOWNERS, templates and AI provenance are present.
- G2 baseline merged through PR #59: module inventory, repository-governance/link/Action-pin checks
  and CI wiring are present; target module dependency/public-entrypoint enforcement belongs to M1–M4.
- G3 planned but intentionally not mixed into this governance PR. Runtime modularization begins only
  after the governance baseline merges.
- G4 partially activated on the current personal repository: squash-only, branch auto-delete,
  Discussions, private vulnerability reporting, Dependabot security updates, full-SHA Action
  enforcement, labels, release Environment and tag immutability are active and read back.
- Organization transfer, team CODEOWNERS, release-tag creation restriction, protected release
  reviewers and administrator enforcement remain blocked on the destination Organization login and
  a second trusted reviewer.
- Windows/Profile upgrade repair merged through PR #75. Issue #76 records that the missing stable
  2.0 channel must be repaired with a verified 2.0.1 rather than republishing the known-buggy 2.0.0
  Windows artifact.
- PR #78 provides the repository-ID-based 2.0.1 transition patch so update discovery remains bound
  to the same public, enabled repository across owner transfer without trusting arbitrary redirects.

## Current decision boundary

The [2026-09-08 integration snapshot](docs/governance/2026-09-08-integration-readiness.md) is
historical. The 2.0.2 release lane #88/#95/#106/#107 is merged and published. Since that tag,
the Windows helper, external-download and pre-login classification repairs (#131/#126/#129),
Renderer/Browser ownership and fixture slices (#108–#120), and compatible Rust updates
(#123/#124/#122) entered `main` in separately checked squash merges. Some lacked an independent
approval and used the maintainer-authorized one-time administrator path; CI was not bypassed.
These source changes have not been packaged or released. They are progress toward M1/M2, not proof
that M1–M5 or G0–G4 are complete. #128 was closed without merging to preserve older-platform
support. Neither local pass counts nor candidate source-size reductions make a post-tag change
part of stable 2.0.2.
The [2026-09-12 combination receipt](docs/governance/2026-09-12-combination-preflight.md) records
the exact four-lane tree and three-platform full-suite/native-fixture results. This closes source
combination testing for that tree, not independent review, distribution packaging or G0–G4.

The maintainer authorized the original-repository transfer and Organization default `read` on
2026-09-12; both are executed and read back. Continue ordinary PR review and M1–M5 inside the
Organization. That transfer authorization did not waive review or checks or authorize another
release. The later convergence authorization permits bounded administrator merges of the present
PR queue after exact-head checks; it does not change branch/tag protections or release authority.
Stable remains 2.0.2; installed-app replacement and real-school validation remain separate
operations. The migration receipt distinguishes completed identity checks from remaining
role-specific workflow, team and release governance work.

On 2026-09-24/25 the maintainer directed convergence of the reviewed PR queue and authorized
one-time administrator merges. #131, #126 and #129 are merged; #125 is closed by the download
repair. #127 stays open because its Windows reporter supplied no sanitized log or stable reproduction;
source/CI evidence cannot establish a successful real Gateway login. #89 remains the documentation
PR until merged. #84 still needs actual Security/Release team decisions and post-transfer settings
readback. The repository's live Secret Scanning and Push Protection read back as disabled on
2026-09-25; the historical transfer snapshot must not be used to claim they are enabled now.

## Historical progress receipt — 2026-09-07

- PR #104 merged and stable 2.0.1 published; Issue #97 closed. Required cloud checks were not
  spoofed and protections were unchanged; release provenance records the designated-host exception.
- The open PR queue is #88 (ProxyCommand), #89 (governance records), #95 (compatibility default).
  Former drafts #90–94/#96 were closed as deferred, not merged; their exact revisions remain in
  Issue #60. Dependency updates #98–103 are deferred in #105 with archived source refs.
- M1–M5 remain incomplete. Local combination evidence does not make those candidates part of
  main or stable 2.0.1. Keep structure and behavior changes independently reviewable.
- Repository ownership is still `heeh02`; G4 is not complete. The goal remains Active.
