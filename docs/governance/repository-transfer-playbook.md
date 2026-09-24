# GitHub Organization transfer playbook

- Status: Current migration procedure
- Owner: Security and Release maintainers
- Last verified: 2026-09-10
- Applies to: transfer from `heeh02/HKUST-GZ-Connect` to `HKUSTGZ-OpenSource`

## Current readiness

Transfer completed on 2026-09-12 with Organization default permission `read`; see the
[migration receipt](2026-09-12-organization-transfer-receipt.md). The following readiness narrative
records pre-transfer conditions, not current blockers. Phase D and role-specific Phase E checks
remain open and must not silently change protections or memberships.

The [transfer-first plan](2026-09-10-transfer-first-plan.md) supersedes old readiness assumptions.
Stable 2.0.2 is published at `39850415c901aeaa77ecb86cd3ce49a2e75290a8`; its four installers,
receipt and hashes are uploaded. The installed Mac app remains an older candidate; do not interrupt
its live connection without approval. Neither replacing that app nor completing refactors is a
prerequisite for repository transfer. Authorization, effective permissions and pre/post-transfer
identity/protection/release checks are the relevant gates.

The destination exists and `heeh02` has active Owner membership, reverified on 2026-09-10.
Repository ID `1279507615` remains under `heeh02`. The shipped 2.0.1/2.0.2 repository-ID updater
satisfies the bridge-publication prerequisite; no new release is needed simply to transfer ownership.
The Organization has no teams and default repository permission `write`. Confirm that permission
decision and recheck destination name availability before transfer; do not change permissions implicitly.
See the [dated readiness receipt](2026-09-07-transfer-readiness.md). Transfer and protection
changes require separate maintainer authorization; offline development continues independently.

## Why a bridge release is required

The 2.0.0 update checker addresses the personal `owner/repository` API path directly. Node's
`https.get` does not automatically follow the HTTP redirect GitHub may return after a repository
transfer. Transferring first could therefore make existing 2.0.0 installations silently stop seeing
future update notices.

Version 2.0.1 resolves repository metadata through immutable GitHub repository ID `1279507615`,
then validates the exact current owner/name/API/Web/Release identity. It must be published from the
personal repository before transfer. This publication gate is satisfied by the stable 2.0.1
release. Publication alone does not upgrade existing 2.0.0 installations: notify users to install
the bridge before transfer and keep a manual download path for clients that have not upgraded.

## Phase A — Destination readiness

1. The maintainer supplies the exact Organization login; agents never invent the public identity.
2. Confirm `heeh02` is an Organization owner.
3. Agree initial accountable maintainers and explicit access. Specialist teams may be created after
   transfer as actual contributors join; empty teams are not a transfer prerequisite.
4. Confirm the destination has no conflicting `HKUST-GZ-Connect` repository.
5. Record Organization plan and policy constraints without purchasing or upgrading a plan unless
   separately authorized.
6. Read the Organization's default repository permission. A `write` default grants broad member
   access after transfer; recommend a reviewed read-only base with explicit team grants. Obtain
   authorization before changing Organization-wide permissions or team membership.

## Phase B — Bridge release under the current owner

1. Merge the independently reviewed Windows/Profile upgrade repair tracked by Issue #74 and PR #75;
   do not republish its known-buggy 2.0.0 predecessor.
2. Merge the repository-ID update through ordinary required CI.
3. Publish `v2.0.1` from the exact reviewed `main` commit. Completed via the maintainer-authorized
   one-time #104 administrator merge; this does not waive ordinary future review/check requirements.
4. Verify all four package assets, digests, signing state and release notes.
5. Verify the published artifact's updater; replacing the maintainer's running app is a separate
   acceptance task and must not interrupt a campus connection without permission.
6. From the published code, query the repository-ID endpoint and confirm that 2.0.2 is the selected
   stable Release.
7. From a 2.0.0 installation before transfer, confirm that the new release is visible.

## Phase C — Transfer

1. Snapshot repository owner, numeric ID, default branch, releases/tags, branch protection,
   Rulesets, Actions settings, environments, secrets names, webhooks, collaborators and open work.
2. Transfer only the exact repository ID `1279507615` to the confirmed Organization.
3. Do not rename the repository during the transfer.
4. Poll the new canonical API path and the old redirect until both are stable.
5. Change Git remotes only after the new owner and unchanged repository ID are read back.

## Phase D — Organization governance

1. Replace personal CODEOWNERS entries with Organization teams.
2. Require code-owner and last-push approval after at least two trusted reviewers exist.
3. Convert/verify main protection as a Ruleset and enable administrator enforcement.
4. Extend the `v*` tag Ruleset with creation restriction and Release-team bypass.
5. Add required reviewers to the `release` Environment.
6. Recheck Discussions, private vulnerability reporting, Dependabot, secret scanning, push
   protection, Action SHA policy and squash-only merge settings.
7. Update canonical repository links in README, Issue templates and governance receipts. The
   updater itself must remain repository-ID based rather than being rebound to the new owner.

## Phase E — Post-transfer proof

- Old clone/fetch URL redirects without credential leakage.
- New clone/fetch/push URL works for the intended roles.
- `main`, all tags, all Releases, assets/digests and Actions history are present.
- Shipped 2.0.1/2.0.2 update discovery resolves the Organization Release URL.
- A clean PR on the Organization repository passes every required check.
- A dry-run patch tag is not created; tag protection is verified through Ruleset readback rather
  than by publishing a fake version.
- `docs/governance/<date>-organization-transfer-receipt.md` records exact before/after evidence and
  remaining risks.

## Rollback boundary

Do not delete the old redirect, recreate a repository at the old path, rename the destination, or
change updater trust rules during the transfer window. If repository ID, releases, protection or
update discovery does not reconcile, stop before creating another release and restore governance
through GitHub Support/owner controls rather than force-pushing tags or history.
