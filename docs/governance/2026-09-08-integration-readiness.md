# Integration and transfer readiness snapshot

- Status: Readback and proposed sequencing; no merge, release or transfer authorization
- Owner: project maintainers, Architecture and Release
- Verified: 2026-09-08
- Scope: repository ID `1279507615`, destination `HKUSTGZ-OpenSource`
- Public main: `9e1135c05dc21998c66627e25477d4bd799cd5d7`

## What is authoritative now

The repository remains `heeh02/HKUST-GZ-Connect`. Stable `v2.0.1` is published (Release
`383930896`), and its annotated tag resolves to the main commit above. The asset inventory has four
installers and three source/build/checksum receipts. Those historical digests were not redownloaded
or revalidated in this documentation audit.

The installed Mac app reports **2.0.2**, not 2.0.0 or published 2.0.1. Its ASAR SHA-256 is
`3c58f7c431a19af3b6d746c22150d79e46b23092fa91c54aad393737a4c2d1bd`.
Its Card Board controller is byte-identical to the original `b3cdc0a` build, not the later PR #106
repairs. A version label does not prove that the latest source is installed. No app was launched,
downgraded or replaced during this readback; no settings, accounts or browser profiles were read.

Main still contains stale 2.0.0/status and unknown-Organization wording. PR #89 corrects that truth;
the correction is not on main until reviewed and merged. Main does contain the six scoped AGENTS,
contributor/security/conduct files, CODEOWNERS, documentation index and module inventory. No tracked
`docs/superpowers/` remains. There are still 59 root-level Desktop test files on main.

## Existing PR queue — do not flatten the dependency chain

| PR | Scope | Base | Remaining decision |
| --- | --- | --- | --- |
| #89 | Governance/readiness records | main | Documentation and Release review |
| #88 | Real ProxyCommand pipe flushing | main | Independent review and chosen-source package validation |
| #95 | Compatible local-proxy default | main | Security/UX review; not currently shipped from main |
| #107 | Native Windows active-context fixtures | main | Test review; does not resolve all Windows-suite debt |
| #106 | 2.0.2 calendar/category behavior | main | Review and new exact-source installers; old packages are stale |
| #108 | Calendar module/view/styles extraction | #106 | Parent first, then structural review/checks |
| #109 | Favorite module and portable ASAR fixture | #108 | Parent first, then structural/test review/checks |
| #110 | Renderer globals/import/HTML ownership policy | #109 | Parent first; Architecture and Security/Release review |

Exact heads observed before this documentation update:

```text
89  69d9f852d2d8166db47fd95a22f09744f7a87b32
88  35a9c8be368c39ac378719a46f759d934a996cdc
95  cdc0398e67128569844b329c753a23d39bbfaa1d
107 5edf08e645bca4febb0de02cdc106576efb5f1a9
106 aeb691a389159a84fe8738448fdc5ee851c63c90
108 40dc7f4d4e733db81a6552cb3209d3ab7ac73ddb
109 990645e5a164e50c8b95f24c6ff0aa7b3e59e1b7
110 c08e7ba8e9f24dcf9ac747a39986ec253d961d48
```

Review independent main-based changes first/as available; preserve the #106 → #108 → #109 → #110
order when integrating that lane. Refresh dependent diffs and rerun affected checks after any base
change. Do not batch administrator merges or reuse a parent's receipt as proof of a new combination.
The ProxyCommand run `33957101203` is successful at the exact #88 head; job `101282297142` records
successful **Verify real Windows ProxyCommand pipes**. That is real CI evidence for #88, not an
authorization or a green result for every other PR. Native/local results elsewhere remain distinct.

## Completion audit — still open

| Goal area | Current evidence | Still missing |
| --- | --- | --- |
| G0 truth | Baseline documents exist; #89 reconciles published/installed/candidate states | Correction on main and final consistent index |
| G1 contributor contracts | Scoped instructions and templates exist | Independent accountable review and effective enforcement |
| G2 ownership | Main inventory; #110 static Renderer guard; #107 fixture repairs | Integrated checks, remaining test moves, full module/public-boundary coverage |
| G3 / M1 | Two explicit feature seams plus view/CSS and static policy in #108–110 | Runtime lifecycle registry, remaining globals, locale ownership and final integration |
| G3 / M2–M4 | Substantial separate local candidates exist | Reconciled reviewed changes, target ownership metrics, exact combined regression/package proof |
| G4 | Organization/Owner and updater bridge confirmed | Permission decision, published-bridge UI acceptance, authorization, snapshots and post-transfer verification |

The local backend candidate `26f67fb3e2f295a6434254d6b31c44b457c634e9` shares the current main
base. Its source has Main 1166 lines, Campus Browser 1499 and Engine CLI 499, versus main's
1719/1854/2485. These are source-size observations, not fresh behavioral acceptance. Browser still
exceeds the 600-line owner target; Main still exceeds the final 500–700-line target.

A read-only `git merge-tree --write-tree --name-only --no-messages` simulation between that backend
candidate and the #110 head reports **23 conflicting files**. They include the session manager,
Renderer bootstrap/calendar/styles, boundary tools, renamed tests, instructions and module map.
Neither branch alone proves the combination. Integrate owned domains selectively and rerun exact
contracts; do not resolve these conflicts by wholesale choosing an older side or regenerating
exceptions. No checkout or branch was merged by this simulation.

The local/native-first and Actions-budget instruction existed in earlier local revision `fbf1048`
but was absent from the current #89 head `69d9f85`. This update restores that instruction while
preserving the separate review, package-acceptance and release-authorization requirements.

Git metadata currently lists 69 local worktrees. This is not a deletion list: unmerged refs,
uncommitted work and necessary receipts must survive. Avoid new duplicate worktrees where an owned
clean branch suffices. Any retirement needs an exact target/owner/status inventory, not broad cleanup.

## When ownership can move

`HKUSTGZ-OpenSource` is Organization `325204819`; the authenticated maintainer has active admin/Owner
membership. No same-name destination repository was listed. The Organization is Free, has no teams,
default repository permission **write**, and does not require two-factor authentication. These are
observations, not permission to change settings or purchase a plan.

Main currently requires one approval and seven contexts: secret-scan, package-verifier, desktop,
desktop-electron, windows-private-file, engine, offline-tests. The repository has one collaborator
with admin role; admin enforcement, code-owner review and last-push approval are disabled. Active
tag Ruleset `22269087` remains present. Independent review is not manufactured by creating empty teams.

Transfer need not wait for every M1–M5 refactor, but must wait for the separately authorized transfer
preflight: agree base/team permissions, complete the published-bridge installation/UI acceptance,
capture fresh governance/release/open-work evidence, recheck name availability, and authorize the
exact existing repository transfer without renaming. A second trusted reviewer is needed for final
independent-review enforcement. Two-factor policy is a separate hardening decision, not a new
invented transfer prerequisite.

Do not downgrade the user's current 2.0.2 candidate just to tick the older bridge acceptance box.
Choose an explicitly approved isolated test account/host or installation workflow that preserves
user data. The existing package-code updater query is useful evidence but is not installed UI proof.
After transfer, verify numeric identity, redirects, roles, rules, releases/assets and updater behavior
using the existing playbook. Until then, source work can continue without claiming migration complete.
