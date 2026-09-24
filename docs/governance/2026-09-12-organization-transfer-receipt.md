# Organization transfer receipt

- Status: Completed ownership transfer; post-transfer governance convergence remains open
- Owner: project maintainers
- Last verified: 2026-09-12
- Applies to: repository ID `1279507615`, stable `v2.0.2`

## Authorized operation and result

The maintainer explicitly authorized transfer and changing the Organization default repository
permission from `write` to `read`. Both operations succeeded and were read back. The original
public repository is now `HKUSTGZ-OpenSource/HKUST-GZ-Connect`; its numeric ID and name are unchanged.
No replacement repository, rename, release, tag or protection change was made. The read-only
Organization default also applies to its other repositories, as disclosed before authorization.

The old web URL responds with HTTP 301 to the new canonical URL. Canonical Git fetch succeeds;
the shared local origin now points to `https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect.git`.
Remote 5070 clones were not implicitly modified.

## Before/after checks

- Main remains `39850415c901aeaa77ecb86cd3ce49a2e75290a8`.
- All 20 tag refs retain the same object SHA; v2.0.2 dereferences to main above.
- All 12 Release records and asset IDs/names/sizes/states/API digests match the fresh pre-transfer
  snapshot. Stable 2.0.2 includes four installers plus its receipt and hash manifest. Large asset
  bytes were not downloaded again; metadata equality is not a new byte-level package verification.
- All 14 open Draft PRs retain their exact base/head refs and SHAs.
- Main protection semantics are identical: one approval, seven strict required checks, no force
  push/deletion, linear history; administrator enforcement remains off. API URLs changed owner only.
- Tag immutability ruleset, two Environment configurations, Actions settings, Secret names and
  webhook metadata are unchanged. No Secret values or webhook destination URLs were captured.
- `heeh02` retains admin. Existing Organization Owner `HernanJiang` now inherits admin; membership
  was independently read back as active/admin. No member or team grant was created by this task.
- Exact published v2.0.2 updater source was executed with a read-only GitHub CLI fetch adapter
  against live repository-ID and latest-release responses. Version 2.0.1 sees an update to 2.0.2;
  2.0.2 sees no update. Both resolve the canonical Organization release page. This validates source
  identity/selection logic, not the installed app's default HTTPS transport or every old client.

Private local before/after snapshots live outside the tracked tree with owner-only file permissions.

## Remaining gates

Reconcile #89's current governance documents and canonical links, review existing module PRs in
dependency order, and verify role-specific contribution/release workflows. A second Organization
Owner exists, but their participation as an independent reviewer has not been confirmed. Do not
waive required checks or convert this transfer authorization into blanket administrator merges.
The existing post-transfer governance audit refuses to qualify the repository without an explicit
Release-team slug. No such team has been configured; no placeholder team or relaxed contract was
introduced to make it pass. Administrator enforcement, code-owner/last-push approvals, Release
reviewers and tag-creation restrictions remain target-state gaps, not regressions from transfer.
No cloud workflow, mock tag, package rebuild, installed-app interruption or real-school operation
was performed. M1–M5 and the full goal are not complete merely because ownership moved.

Keep the old path unoccupied so redirects remain intact. Legacy 2.0.0 users should manually install
a current release if update discovery fails. Repair any later migration discrepancy in place;
do not automatically transfer back or recreate published tags/assets.

## Security-settings follow-up — 2026-09-12 11:38 UTC

The live governance capture reports repository Secret scanning and Push protection both disabled.
Private vulnerability reporting and Dependabot security updates remain enabled. Repository admin
permission is available; the public Organization uses the Free plan and its corresponding defaults
for new repositories are false. The immediate transfer snapshots did not comprehensively capture
these security-and-analysis fields, so their change cannot be attributed to transfer from this
evidence. The earlier identity/asset/protection equality claims do not establish security parity.

This contradicts the maintained governance contract and is an outstanding security-control gap.
Enabling these two repository-level controls requires the maintainer's explicit settings approval;
do not change Organization-wide defaults or branch/tag protections implicitly. Required review is
also still outstanding: #89 remains Draft with REVIEW_REQUIRED and no check results. No new source
or release should be described as fully governance-qualified on the basis of migration alone.
