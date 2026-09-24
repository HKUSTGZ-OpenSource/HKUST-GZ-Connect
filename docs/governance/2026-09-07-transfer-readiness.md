# Organization transfer readiness after 2.0.1

- Status: Historical readback receipt; transfer NOT performed
- Owner: Security and Release maintainers
- Last verified: 2026-09-07
- Applies to: repository ID `1279507615`, stable `v2.0.1`, destination `HKUSTGZ-OpenSource`
- Supersedes: earlier claims that the destination is unknown or the bridge is unpublished

## Verified repository and release

The repository is still `heeh02/HKUST-GZ-Connect`, public, with default branch `main`.
Main and immutable annotated tag `v2.0.1` resolve to
`9e1135c05dc21998c66627e25477d4bd799cd5d7`. Release ID `383930896` is published, not a draft
or prerelease, and is selected by `/releases/latest`. PR #104 is merged; Issue #97 is closed.

The four installers retain build source `fafcb6c03c2d01eba2085c7d4a693e9f65ffc538`.
Only `.github/workflows/ci.yml` and its regression test differ from the release source.
The original `BUILD_RECEIPT.json` and `SHA256SUMS.txt` were preserved; the release's
`RELEASE_SOURCE_RECEIPT.json` records the reviewed PR head, main commit and source equivalence.
Do not describe these installers as rebuilt from the squash SHA or as cloud-validated.

The live v2.0.0 tag resolves to `5287c86842a506cd595e22b95d023b6a7e02cbea`.
Earlier 2.0.0 tag/build references in historical records are not current release provenance.

## Package-code update discovery

The actual `lib/platform/update/update-check.js` was read from each App's ASAR, compiled in an
isolated Node 24.19.0 module and invoked with that App's package version. Only public GitHub
metadata was requested; no Electron startup, user settings, campus authentication, clipboard or
saved credentials were accessed. This is package-code query evidence, not an installed UI test.

| Package code | Actual result before transfer |
| --- | --- |
| Installed `/Applications/hkustgzconnect.app`, version 2.0.0 | `updateAvailable=true`, latest `2.0.1`, canonical personal-repository v2.0.1 release URL |
| Verified macOS arm64 2.0.1 package | `updateAvailable=false`, latest `2.0.1`, same canonical release URL |
| Verified macOS x64 2.0.1 update module | Byte-identical to arm64 and published main; no separate live invocation |

Updater source SHA-256 values:

- installed 2.0.0: `fba100616c6fd8d1c8dbb65b53ca3f6927740320a36053a7675d4e5ac8156a64`
- both verified 2.0.1 packages and main: `73db4ab366612e53274806bbc20d6a9b2ba659deefbc26a1a2cc00d056a1250f`

The installed App remains 2.0.0. Its code can discover the bridge now, but users who do not
install it may still encounter the old updater's redirect limitation after transfer. Publication
does not retrofit the old binary. Notify users before transfer and retain a manual download path.

## Organization and governance readback

- Destination `HKUSTGZ-OpenSource`, ID `325204819`, exists; `heeh02` membership is active/admin
  (Organization Owner). The current account also has repository administrator permission.
- Destination repository list contains `demo-repository`, not `HKUST-GZ-Connect`; no name conflict
  was observed. Recheck immediately before the transfer operation.
- Organization plan is Free; member repository creation is enabled. No team currently exists.
- **Default repository permission is `write`.** Transferred repositories inherit Organization
  defaults. Before transfer, obtain the maintainer's decision on a read-only base plus explicit
  team grants, or an explicit acceptance of the current broader member access. No setting was changed.
- Main requires one approval and seven strict status contexts: `secret-scan`, `package-verifier`,
  `desktop`, `desktop-electron`, `windows-private-file`, `engine`, `offline-tests`.
  Administrator enforcement, code-owner review and last-push approval are not enabled.
- Active tag Ruleset `22269087` is named `release-tag-immutability`. Its presence is not proof
  that future Organization team/creation restrictions have been configured.

The one-time administrator merge for #104 is recorded in the release receipt. It does not grant
standing permission to bypass these checks, merge another PR, transfer ownership or change rules.

## Remaining migration gates

1. Install/verify the published 2.0.1 macOS package and its installed UI update path while preserving
   user data. The package-code checks above do not complete this installation gate.
2. Agree Organization base/team permissions and identify a second trusted reviewer before enabling
   rules that require independent people. Empty teams alone do not provide independent review.
3. Capture a fresh pre-transfer snapshot of settings, tags/assets, Actions, environments, secret
   names only, webhooks, collaborators and open work. This receipt is not that complete snapshot.
4. Obtain separate authorization and transfer the existing repository without renaming or creating
   a second copy. Recheck unchanged repository ID, redirects, new remotes, update discovery,
   releases and effective permissions after transfer.
5. Complete the post-transfer governance receipt and exact-tree checks. M1–M5 modularization and
   remaining product candidates continue independently; unfinished refactors need not delay ownership.

## Reproduction and limits

Read-only metadata commands include `gh api repos/heeh02/HKUST-GZ-Connect/releases/latest`,
`gh api repos/heeh02/HKUST-GZ-Connect/commits/v2.0.1`,
`gh api user/memberships/orgs/HKUSTGZ-OpenSource`, `gh api orgs/HKUSTGZ-OpenSource`,
`gh api orgs/HKUSTGZ-OpenSource/repos`, `gh api orgs/HKUSTGZ-OpenSource/teams` and the repository's
`branches/main/protection` endpoint. Project documents describe only the observed fields above.

Read an ASAR module with `@electron/asar.extractFile(archive, 'lib/platform/update/update-check.js')`,
provide an explicit string filename to Node's CommonJS module compiler, then call exported
`checkForUpdate` with the archive's `package.json` version. Do not execute the application entrypoint
or substitute a fake owner when claiming live transfer verification.

No repository transfer, new release, protection/Organization permission change or live-school
test was performed. No installed App or user data was changed. These documentation changes can
be reverted independently; they do not change update trust, runtime behavior or storage formats.
