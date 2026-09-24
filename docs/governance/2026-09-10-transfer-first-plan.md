# Transfer-first convergence plan

- Status: Transfer executed 2026-09-12; subsequent convergence plan remains active
- Owner: project maintainer
- Last verified: 2026-09-12
- Applies to: `main@39850415c901aeaa77ecb86cd3ce49a2e75290a8`, stable `v2.0.2`, G0–G4 and M1–M5
- Supersedes: unpublished-2.0.2 assumptions in earlier readiness snapshots

## Decision

Update: original-repository transfer and Organization default `read` were explicitly authorized
and completed on 2026-09-12. The [migration receipt](2026-09-12-organization-transfer-receipt.md)
supersedes preflight-only and pending-authorization statements below. The dated baseline is retained
for comparison; remaining work is PR/module and post-transfer governance convergence.

Transfer the existing repository to `HKUSTGZ-OpenSource` after a minimal identity, access,
permission and release-integrity preflight. Continue modularization inside the Organization.
Do not require completion of all modules, closure of all PRs, replacement of a running Mac app,
or creation of every future specialist team before transfer.

The original updater bridge was a real sequencing dependency. It is now satisfied: 2.0.1 and
2.0.2 contain update discovery through immutable repository ID `1279507615`. Publication does
not upgrade old clients automatically; retain a manual download path for 2.0.0 users.

## Verified baseline

| Area | Current evidence | Implication |
| --- | --- | --- |
| Source | `heeh02/HKUST-GZ-Connect`, ID `1279507615`, public, main above | Transfer this repository; do not mirror into a replacement |
| Stable | 2.0.2 published, not draft/prerelease; four installers plus receipt and hashes | Do not rebuild, retag or republish merely for owner transfer |
| Organization | `HKUSTGZ-OpenSource`, ID `325204819`; active admin membership | Destination identity and current owner access established |
| Destination name | Organization repository listing contains no `HKUST-GZ-Connect` | No current same-name conflict; recheck immediately before transfer |
| Permissions | Free plan, default repository permission `write`, no teams | Explicit permission decision needed; do not change Organization-wide defaults silently |
| Main protection | One approving review, seven required status contexts; admin enforcement off | Preserve effective protection; previous release exception is not ordinary merge authority |
| Open work | 14 draft PRs: #89 and #108–#120; eight open planning/backlog issues | Preserve unfinished work; migration does not require merging it first |
| Local footprint | 74 worktrees after verified cleanup on 2026-09-12; some share dependency caches | Inventory before cleanup; count is not proof of disposable data |
| Main hot spots | `desktop/main.js` 1,719 lines; `ec-engine.rs` 2,485 lines | Candidate refactors are not yet shipped architecture |
| Local installation | Installed Mac ASAR differs from published package | App replacement and a live connection interruption are separate decisions |

## Minimum transfer gate

### Execution correction — 2026-09-12

The transfer-first sequence already existed, but continued local extraction and combination
work did not advance ownership migration. Do not turn that work into new transfer prerequisites.
Live readback still places main at `39850415c901aeaa77ecb86cd3ce49a2e75290a8`; stable 2.0.2 is
published with four installers and two provenance assets. There are 83 local worktrees.
The latest local combination is not main or a released product.

For the next convergence cycle:

- Freeze new decomposition branches, PRs and speculative module extraction. Finish migration
  preflight and the permission decision first; do not rebuild 2.0.2 for a namespace change.
- Keep one migration/governance owner and at most two active code lanes. Each lane has at most
  one merge-ready PR; dependent drafts remain preserved rather than being worked simultaneously.
- If the maintainer decision is pending, limit work to the existing PR inventory and bounded
  review corrections. Do not repeatedly run full suites on unchanged sources or create another
  dated plan. A pending transfer decision does not require expanding architecture work.
- After transfer, reconcile #89 and then drain existing dependency lanes before starting another
  extraction wave. Squashed parents require explicit descendant diff/base reconciliation.
- Accept modularization by public contracts, lifecycle/resource ownership and regression evidence;
  smaller entrypoint files alone are not completion. Keep line budgets as regression guards.
- Maintain this procedure, GOAL, the status index and module map as the current navigation set.
  Keep exact-source receipts as evidence; do not copy all historical results into each plan.

This is a proposed execution constraint, not authorization to change Organization permissions,
merge drafts, remove worktrees or publish another version.

Read-only metadata capture at 2026-09-12 08:29:20 UTC succeeded for 16 endpoint groups:
20 tag refs, 12 releases with asset identities/digests where supplied by GitHub, 14 open PRs,
main protection, the effective tag ruleset, two environments, Actions permissions, collaborators,
webhook metadata (zero hooks), and repository/environment Secret names only. The private local
snapshot is outside the tracked tree, with owner-only file permissions; no Secret values or
webhook URLs were captured. All ten PR dependency edges match their parent head SHA exactly.
This is a pre-transfer comparison baseline, not asset-byte verification, role-based push testing
or post-transfer acceptance. Recheck mutable state immediately before an authorized operation.

1. Immediately before transfer recheck source ID, destination membership and same-name availability.
2. Agree effective access: recommend read-only Organization base plus explicit repository grants.
   Changing that base affects other Organization repositories and requires explicit approval.
   An explicit decision to retain `write` is a documented risk, not a technical impossibility.
3. Capture exact main/tag objects, release and asset IDs/hashes, all PR bases/heads, repository and
   effective Organization policies, environments, webhook configuration and credential *names only*.
4. Verify shipped updater identity resolution. Preserve repository name and public visibility.
5. Confirm the bounded transfer operation; do not treat the consumed 2.0.2 admin-merge exception
   as standing permission for future merges or protection changes.

During the short transfer window, stop pushes/merges/releases. Transfer once, without a simultaneous
rename. Read back unchanged repository ID, source/tag objects and release assets at the destination;
verify old URL redirect, canonical fetch, updater resolution and effective protections. Update
remotes only after that readback. No mock release or test tag is needed.

If validation fails, suspend new releases and repair the identified access/configuration issue;
do not delete tags, recreate the old path or attempt an automatic transfer-back.

## Existing PR convergence order

| Lane | Existing PR order | Policy |
| --- | --- | --- |
| Governance | #89 | Reconcile status/GOAL/transfer receipt in one existing PR |
| Renderer | #108 → #109 → #110 → #114 → #115 → #116 → #117 → #118 → #119 → #120 | Review from the root; after each squash merge, reconcile the next base and exact diff |
| Browser acceptance | #111 | Native popup/MFA fixture evidence; not a live-school claim |
| Browser downloads | #112 → #113 | Preserve separation between ownership extraction and behavioral repair |

All are currently drafts. This ordering is not merge approval or proof of acceptance. Inspect each
head against current main; retain necessary behavior/security fixes and do not automatically close
a PR as redundant based only on its title or overlapping paths. A closed superseded PR needs an
exact replacement commit/PR and preserved unique work. A governance or test PR does not substitute
for independent review of production code.

Do not bulk-rebase all descendants or open more decomposition PRs while this queue is unresolved.
Keep at most one merge-ready PR per production lane. M3/M4 expansion resumes only after the active
Renderer/Browser batches have landed or been explicitly deferred. M5 checks accompany each batch.

## Lightweight governance inside the Organization

- Start with accountable maintainers and contributor/triage roles; specialist teams can follow real
  membership rather than creating empty Engine/UI/Security/Release teams as a transfer prerequisite.
- Keep human review independent. Several AI agents owned by one maintainer are not the second
  trusted human reviewer required by branch policy.
- Preserve existing protections. Cloud-budget constraints require an approved validation strategy,
  not fabricated statuses, disabled workflows or routine administrator bypasses.
- Use #60 as the aggregate goal and existing #79–#84/#105 as outcomes/backlog; do not create parallel
  tracking issues for the same work. Close only against actual acceptance or explicit deferral.
- Main remains authoritative. Maintain GOAL, status index and module map; archive dated evidence,
  not another competing live plan for every agent.

## Resource and file convergence

Mac performs source changes, focused tests and required macOS package/GUI acceptance. Use 5070
Windows and WSL for native Windows/Linux heavy builds. An owner transfer requires no package rebuild.
Batch pushes after local checks; do not trigger cloud builds as an exploratory loop.

Before deleting a worktree, record branch/head, dirty paths, unique commits, PR disposition and
symlink/dependency consumers. Remove only owned generated outputs and clean worktrees with a
verified preserved reference. Unmerged patches, private-review notes, installed app data and shared
dependency caches are not garbage. Avoid blanket branch deletion and broad recursive cleanup.

The first bounded cleanup removed nine obsolete Renderer checkout copies on 2026-09-12, reducing
83 worktrees to 74. Every target was clean including ignored/untracked files, outside active PR
heads/bases, and had its exact commit preserved by its own branch and a descendant branch. No open
files or incoming filesystem symlinks targeted those directories. Branches and commits remain
intact and can recreate each checkout; no force option, remote deletion, shared-cache cleanup or
installed-app operation was used. Local metadata records the nine exact paths/SHAs. The removed
directories accounted for about 127 MiB in `du`; this is not a measurement of immediately reclaimed
APFS storage. Dirty, detached and dependency-bearing worktrees were preserved.

## Completion checkpoints

- T1: explicit destination permission/transfer decision and complete preflight.
- T2: successful unchanged-ID transfer with release/update/protection readback.
- T3: governance current-state PR accepted, active PR lanes reduced by evidence-backed decisions.
- T4: each M1–M5 outcome accepted or explicitly deferred with owner and trigger; final GOAL evidence.

T2 may finish before T3/T4. Do not report full governance or modularization completion merely
because the repository has moved.

## Reference

[GitHub repository transfer documentation](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository)
describes preservation of repository work, redirects and inheritance of Organization permissions.
The existing [transfer playbook](repository-transfer-playbook.md) supplies the detailed checklist;
its dated readiness statements are historical where this verified release baseline supersedes them.
