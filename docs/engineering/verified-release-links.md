# Verified release notification links

- Status: Current source contract
- Owner: Desktop / platform maintainers
- Last verified: 2026-09-26
- Applies to: development source after published v2.0.3; not shipped in that tag

## Boundary

`checkForUpdate` discovers the current repository through its immutable GitHub ID,
validates its current owner/release prefix, and returns a bounded notification.
Main alone retains the latest available-update result. The update action accepts
only the exact URL Main issued; Renderer cannot supply another release, query,
suffix, protocol, repository or former-owner URL.

Calling the prefix validator without a repository prefix correctly returns false.
The prior Main action did this, inadvertently rejecting every legitimate update
notification. The fix uses an issuance check against the already verified result,
not an arbitrary default owner or a relaxed URL allowlist.

This action opens a release page. It does not download, install or execute an asset,
change the repository owner, replace an installed app or modify persisted schemas.

## Validation and rollback

Unit tests cover legitimate current-owner URLs, absent/no-update notifications,
tampered URLs and repository transfer. The native Electron fixture
`desktop/e2e/verified-release-link.electron.js` exercises real Main, Preload and
Renderer with synthetic GitHub responses and a captured OS opener. It makes no
real update request and touches only its newly created temporary profile.
Its Windows fixture protects both owned synthetic settings copies before migration.

Run `node --test test/unit/platform/update/update-check.test.js` from Desktop, then
run the Electron fixture using the installed Electron development runtime. Also
run the Desktop, architecture, syntax, install-script and exact-tree secret gates.
Native-platform results are separate from portable unit evidence.

Rollback is a source revert of the update-check/Main issuance guard and matching
tests; there is no data migration. Do not rewrite the published v2.0.3 tag or assets.
