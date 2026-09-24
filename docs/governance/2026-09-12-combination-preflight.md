# Candidate combination preflight

- Status: Dated combination source/fixture acceptance evidence; not merge or release approval
- Owner: project maintainers
- Last verified: 2026-09-12
- Applies to: published main `39850415c901aeaa77ecb86cd3ce49a2e75290a8` and the exact candidates below

## Inputs and result

The open queue still contains 14 drafts. Existing Renderer dependencies are represented by the
chain tip; no draft was merged, closed or declared complete in this preflight.

| Lane | Exact tip |
| --- | --- |
| Renderer / Integration Center (#120) | `239419dbdec843eb496efcfaef471222370aa934` |
| Browser download lifecycle (#113) | `7ff7eca97061c02e2225a3f2575a8d24b655d897` |
| Popup MFA test ownership (#111) | `178b94493bf5a39028649e63fd447d6f73d2e72d` |
| Governance (#89) | `85016009a9ba110308a9a41b8dcd51fad36a3b7c` |

Run `git merge-tree --write-tree` sequentially in that order. Intermediate unreferenced local
commit objects carry the two parents solely to preserve merge-base semantics for the next step;
no branch, tag, checkout or remote ref is moved by creating these inspection objects.

1. Renderer + Browser tree: `d756a5ae749d777129f1d924159638e8dbe3cd5e`.
2. Add popup fixture: `5aa076ff66764ed4b3c7868fe5684023e976809f`.
3. Add governance: **`8a59beb8a115258d8921dbce94d0296dcbac2a00`**.

All three merge-tree operations returned success without textual conflicts. The combined owned
Electron fixture helper matches #111 exactly (SHA-256
`8a67fb2afcd199caca647fedb3b829fd55d29981964cdce2fb5a7a4053c145da`).
The combined difference from published main spans 139 files; this is not a small release patch.
The existing exact-tree JavaScript syntax gate passed 531 sources on the final tree, and its
exact-tree secret scan passed. These checks inspect the combined blobs, not a different checkout.

## Current acceptance summary

The merge-tree preflight alone proved no runtime behavior. The separate whole-combination runs
recorded below now cover this exact tree on all three designated platforms:

| Platform | Full suite | Native DownloadItem / popup MFA / Renderer ASAR |
| --- | --- | --- |
| Mac | 1,471 passed / 14 skipped / 0 failed | Passed with child-close and cleanup confirmation |
| Linux 5070 | 1,471 passed / 14 skipped / 0 failed | Passed under Xvfb with cleanup confirmation |
| Windows 5070 | 1,445 passed / 40 skipped / 0 failed | Passed with cleanup confirmation; GPU warnings remain |

These are actual whole-combination runs, not sums of per-lane evidence. Full distribution packages,
signing, real-school behavior and independent review of Main/IPC/security changes remain open.
No tested candidate has been merged to main. Revalidate any changed source after review or squash.

## Whole-combination Mac follow-up — 2026-09-12

The existing `goal-combination-check` worktree was switched detached to inspection commit
`dfc75d463cda4c1dc9c03f1bd8b6a9ad3c8ff1fc`, and its tree was verified as the exact final tree above.
Its pre-existing untracked historical receipt and existing dependency directory were preserved.
No implementation branch was created or moved.

Mac Node 24 full `node --test`: **1,471 passed, 14 platform skips, zero failures (1,485 total)**.
Architecture, install-script and repository-governance checks passed. Existing Electron 43.2.0
ran the Node-owned native DownloadItem, popup-MFA and Renderer-ASAR fixtures successfully; all
three confirmed child closure and temporary-data removal. Tests use synthetic/loopback data only.
These are whole-combination results, not sums of per-lane test counts.
The native control-shell layout fixture also passed on the same tree.

At this Mac checkpoint Windows/Linux combination tests were outstanding; the later sections record
their completion. Distribution packages, live-school behavior and independent review remain open.
The earlier #120 results alone exclude this combination. No dependency installation or installed-app update ran.

The package manifest still says 2.0.2. That is inherited source metadata, not authorization to
replace the already-published immutable 2.0.2 tag or assets. Any future release needs its own version,
exact-source acceptance and authorization. Organization transfer is independent of this whole-stack
acceptance and still requires the pending permission/transfer decision.

No new implementation branch, dependency cache, build artifact, Actions run, PR merge or release
was created. Local inspection objects are reproducible from the recorded input commits.

## Whole-combination Linux follow-up — 2026-09-12

The existing designated 5070 WSL inspection checkout advanced detached to
`dfc75d463cda4c1dc9c03f1bd8b6a9ad3c8ff1fc`; readback verified tree
`8a59beb8a115258d8921dbce94d0296dcbac2a00`, identical to the Mac combination.
Node v24.20.0 with umask 022 passed **1,471 tests, 14 platform skips, zero failures (1,485 total)**.
Native architecture checks and all three Node-owned fixtures passed under `xvfb-run -a`:
DownloadItem completion/cancellation/retirement, popup MFA assertions/cleanup, and Renderer ASAR
startup/retirement. Each runner confirmed child closure and fixture removal; no no-sandbox override
was used. All fixture data is synthetic or loopback-only.

Existing Linux dependencies were reused; process-local NODE_PATH referenced the previously
lockfile-verified Acorn tooling through WSL. No dependency download or package build was performed.
The pre-existing dependency symlink remains the only untracked checkout path; temporary transfer
bundles on both hosts were removed and the full-suite log remains on 5070 for audit.

This closes Linux full-combination source/fixture acceptance; Windows completion is recorded in the
next section. Distribution packages, real-school behavior and independent review remain open. No installed app,
credentials, user files, repository protection, release or Organization transfer was changed.

## Whole-combination Windows follow-up — 2026-09-12

The existing 5070 native Windows Git inspection directory was verified clean and switched detached
to `dfc75d463cda4c1dc9c03f1bd8b6a9ad3c8ff1fc`. Independent `git show -s --format=%T HEAD`
readback confirmed `8a59beb8a115258d8921dbce94d0296dcbac2a00`, identical to Mac/Linux.
The initial diagnostic command lost its caret under CMD escaping; that failed tree print was not
used as evidence. Initial SSH handshakes timed out; access recovered without host/service changes.

Node v24.20.0 full suite: **1,445 passed, 40 platform skips, zero failures (1,485 total)**.
Architecture passed. The Node-owned native DownloadItem, popup-MFA and Renderer-ASAR fixtures all
passed with child-close and temporary-profile removal confirmed. Four GPU exit-code-34 warnings
occurred during popup/ASAR execution; clean hardware acceleration is not established.

The existing native private-file helper and dependency cache were reused; Acorn came from the
previously verified isolated tooling via process-local NODE_PATH. No dependency/compiler install,
package build, actual user export or real-school authentication occurred. Synthetic fixture
downloads used only temporary destinations. Temporary local transfer bundles were removed.

All three platforms now have full-suite and these native fixture results for the same combined
source tree. Distribution packages, signing, real-school behavior, independent review and the
authorized Organization transfer remain separate unfinished requirements. No PR/main merge,
tag, release, protection or installed-app change was performed.

## Goal gap audit — 2026-09-12

Measured from Git blobs (line counts exclude trailing blank lines), not worktree intent:

| Requirement / metric | Published main | Tested combination | Conclusion |
| --- | ---: | ---: | --- |
| Desktop Main lines; M3 final 500–700 | 1,719 | 1,719 | M3 incomplete |
| Rust ec-engine entry lines; M4 below 800 | 2,485 | 2,485 | M4 incomplete |
| Campus Browser lines; M2 owner target at most 600 | 1,854 | 1,804 | Extraction helps, M2 incomplete |
| Renderer app lines | 563 | 562 | Not proof of full bootstrap separation |
| Shared Renderer CSS lines | 2,156 | 1,981 | Partial ownership improvement |
| Legacy i18n facade lines | 1,524 | 4 | Locale extraction present in candidate only |
| Root-level Desktop test files | 59 | 59 | M5 placement migration incomplete |

The combination registers six native feature domains but retains 29 legacy owners with 106
export/top-level-binding exceptions. M1's no-hidden-HTML-order exit condition is therefore not
proved. Removing a facade or passing the static guard is not completion of all Renderer ownership.

G0/G1/G2 have a baseline on main and proposed improvements in #89/the candidate stack. G3/M1–M5
remain partial. G4 remains incomplete: repository owner is still the personal account; branch
readback requires one approval and seven named contexts, with admin enforcement disabled. The
configured post-transfer target additionally requires code-owner/last-push approval, release
reviewers and restricted tag creation; none is claimed implemented by this source test receipt.

Issues #60, #79–#84 and #105 remain open. Do not close them on test counts or move their outcomes
into an implicit deferral. Organization authority gates only external actions, not remaining
offline implementation. The next implementation work must select an existing owned seam and
reduce a stated gap; it must not continually recreate/revalidate the already-tested combination.
Before production integration, preserve independent review, package acceptance and explicit
authorization. Candidate acceptance does not change published main or make a new release necessary
for the repository transfer itself.

## M3 update-notification seam combination — 2026-09-12

Combine the original four-lane inspection commit `dfc75d463cda4c1dc9c03f1bd8b6a9ad3c8ff1fc`
with local update-notification candidate `82ac2adf1ad7fc431a68e2849787c7a96fbae114` in the existing
detached inspection worktree. Only the architecture line-budget conflict required resolution:
retain the lower Main limit 1,682 and lower Renderer limit 562. Neither bound was increased.
Resolved tested tree: `79f681ea0c45247dba4b40c151e92598d0b5d863`.

Mac Node 24 full suite: **1,482 passed, 14 platform skips, zero failures (1,496 total)**.
Native Renderer ASAR startup/cleanup and synthetic verified-update Main/Preload roundtrip passed.
Architecture, install-script and repository-governance checks passed; exact-tree syntax passed
533 sources. The new Main count is 1,682, while direct/transitive dependency limits remain 36/170.
The prior four-lane tree and its three-platform evidence are unchanged historical inputs, not
three-platform validation of this extended tree.

No new PR or implementation branch, installed-app update, dependency installation, package build,
real GitHub update request, release or Organization transfer occurred. The existing untracked
historical inspection note remains untouched. This combination includes the separately reviewable
verified-link prerequisite; it must not be mislabeled wholly structural. Windows/Linux extended
combination, distribution packages and independent review remain outstanding.

## M5 coverage combination — 2026-09-12

The M3 combination `aa476e5288816e91a8622775e4ece3c01aed7cd3` combined without conflicts with
the existing module-map candidate `5fe6047`. Tested tree:
`0dae54ef1d49efde65e051531ebefe3b1d295b43`. Coverage finds one owner for all 308 in-scope
production paths and no missing/stale public entrypoints. This scope does not cover every test
or prove dependency direction; `dependencyEnforcement: inventory-only` remains explicit.

Mac source tests: 1,492 passed, 14 platform skips, zero failures (1,506 total). Architecture,
exact-tree syntax (535 sources) and staged secret checks passed. The existing inspection
node_modules resolves js-yaml 4.3.1 before NODE_PATH; these full-suite results therefore are not
locked-dependency acceptance. A separate bounded VM loaded the unchanged coverage checker with
only the verified 4.3.2 parser injected and passed the same 308-path coverage. This separate
parser check is not a rerun of the full suite with 4.3.2. Existing dependencies were not modified.

No runtime source was changed by this combination. Main/Renderer limits remain 1,682/562.
Locked-dependency full-suite, native GUI, Windows/Linux and package acceptance of this expanded
tree remain pending. No new implementation branch, PR, release, Organization or permission
operation was performed. The pre-existing untracked inspection note remains untouched.

## Locked Linux dependency follow-up — 2026-09-12

Exact M5 combination commit: `f229f26b6917d1d62f2a870a7009ca227c394711`, tree
`0dae54ef1d49efde65e051531ebefe3b1d295b43`. An isolated 5070 WSL inspection checkout reused Git
objects but installed its own dependencies with `npm ci --ignore-scripts --no-audit --no-fund`.
The lockfile installed 274 packages; actual resolution verified js-yaml 4.3.2 and Acorn 8.18.0.
Node v24.20.0 full suite passed **1,492 tests, 14 platform skips, zero failures (1,506 total)**.
This supersedes the earlier cache-mixed full-suite limitation for this Linux source run only.

WSL SSH initially timed out. Windows-host readback proved the target directory still empty before
retrying via a fixed WSL shell script, so no duplicate install/test job was started. No shared
dependency directory, host service or network setting changed. The isolated remote dependencies
occupy 415 MiB; the only untracked source-checkout path is the synthetic test log. The local
transfer bundle was removed. Remote tooling and logs remain for subsequent acceptance.

Lifecycle/install scripts and npm vulnerability auditing were deliberately not executed. npm emitted
existing deprecation warnings; this result does not establish vulnerability-free dependencies,
native binaries, Electron package installation, GUI or distribution readiness. No package build,
real-school operation, new PR, merge, release or Organization transfer occurred. Mac/Windows locked
dependency acceptance and full installers remain pending for this expanded combination.

## Locked dependency advisory follow-up — 2026-09-12

On the same isolated Linux checkout at `f229f26b6917d1d62f2a870a7009ca227c394711`, `npm audit
--json` returned exit zero, report version 2, and zero info/low/moderate/high/critical findings
(274 dependency records). The project's `npm run audit:ci` also passed with `npm, total=0`;
no OSV fallback was needed. Manifest/lockfile diff stayed empty; lockfile SHA-256 is
`dc03ba243406af81e4e01587e765c24b20c94e79781b7713a0238f5d3903e223`.

The structured audit output and synthetic unit-test log remain untracked on 5070; no dependency
was upgraded or installed this turn. This supersedes only the earlier npm-advisory-audit omission.
Deprecation warnings remain maintenance signals and are not identical to advisory findings.
An advisory database's zero result is dated evidence, not proof of absence of unknown vulnerabilities.
Install scripts, native package artifacts, additional platform acceptance and independent review
remain separate gates. No automatic fix, cloud workflow, release or Organization operation ran.

## Test-placement combination — 2026-09-12

Combine M5 inspection `f229f26b6917d1d62f2a870a7009ca227c394711` with test-placement candidate
`7725c04`. Resolve governance conflict by retaining schema-2 module coverage plus the zero-root-test
manifest check, not restoring the older textual module parser. Preserve current native feature
imports in relocated auth/favorites/integration/strict-proxy tests and adjust their relative depth.

The first run exposed two additional path failures after automatic merging: Main settings contract
looked under test/contracts/lib, and Renderer contract imported its script parser from an obsolete
relative location. Only those paths were corrected; no assertions or test cases were removed.
Final tested tree: `526add30dc4104b964b02a8cbe88306a33f5ea81`.
Mac Node 24 source tests: **1,495 passed, 14 platform skips, zero failures (1,509 total)**.
Governance passes both coverage and an empty root-test debt list; Git inventory confirms zero
root JS/CJS/MJS test files. Architecture remains within 1,682 Main / 562 Renderer line budgets.

This local run reuses the existing inspection dependency cache, so it is not locked-dependency
acceptance; the earlier isolated Linux run is on the preceding tree. Windows/Linux relocated-test
and full distribution-package acceptance remain pending. No production logic, user data, existing
untracked inspection note, remote PR, release or Organization settings were changed.

## Relocated tests with locked Linux dependencies — 2026-09-12

Exact commit `c7366247f8c61cf460358a4ac5ab9fbe1755c230`, tree
`526add30dc4104b964b02a8cbe88306a33f5ea81`, ran in the existing isolated 5070 dependency checkout.
The lockfile is unchanged from the preceding clean install; no npm install was repeated.
Actual resolution reports js-yaml 4.3.2 and Acorn 8.18.0. Node v24.20.0 with umask 022 passed
**1,495 tests, 14 platform skips, zero failures (1,509 total)**. Module-coverage/root-test-debt
governance and architecture checks also passed. Manifest and lockfile remain unmodified.

This supplies Linux locked-dependency source acceptance for the relocated tests, not Windows,
native GUI, install scripts or distribution packages. Existing synthetic logs were preserved;
temporary transfer bundles on Mac and WSL were removed. No new dependency cache, installed-app
change, public branch update, merge, release or Organization operation occurred.

## M4 private argument-owner combination — 2026-09-12

Input combination `c7366247f8c61cf460358a4ac5ab9fbe1755c230` plus Engine argument-owner candidate
`b0be6ca8b0212f3931bd6bb7ba478e683a2b64e1` produced conflict-free tree
`93b1734a856554ecf676c7461a0075d675c07b85`. The map includes `independent/src/bin/engine_app/**`;
the Engine entrypoint now has 2,110 lines, while Main remains 1,682. M3/M4 final targets remain unmet.

Exact Git comparison confirms the entire independent directory matches the Engine candidate and
the Desktop directory matches the preceding combination. Seventeen coverage/governance tests,
pinned Rust formatting and indexed secret checks passed on the combined source. This focused
verification does not claim a fresh combined Cargo/GUI/native-package run. The candidate's Linux
Rust evidence remains tied to its recorded source; Desktop and Cargo ownership were not conflated.

No new branch, PR, dependency build/download, installed binary, release or Organization mutation
occurred. The pre-existing untracked inspection note remains preserved. The separate later M5
check-vocabulary correction is not yet included in this tree; integration and cross-platform
acceptance must retain that outstanding item rather than silently declaring all M5 work complete.

## Close recorded combination omissions — 2026-09-12

The existing detached inspection combines the reviewed display-clear repair `b8848cb` with the
previously omitted M5 check-vocabulary correction `e011dd7`. Both merges are conflict-free; the
browser-data settings regression follows its relocated unit-test path without restoring root debt.
Tested tree: `9f49c3ea5c2899ef86363994d1dc26c840f39a44`. Thirty focused governance/lifecycle tests
and the Mac full source suite pass: **1,498 passed, 14 platform skips, zero failures (1,512 total)**.
The Mac native schedule fixture also passes, including dialog-close failure and pending-reply
retirement. Architecture, exact-tree syntax and secret checks pass; Main/Renderer remain 1,682/562.

The first full run omitted the required Acorn lookup path and failed to load tooling. Reusing the
existing Acorn through process-local NODE_PATH resolves it; no dependency or gate was changed.
The inspection still resolves its older local js-yaml 4.3.1 cache. Thus this is not a clean locked
dependency run. The separate #114 Windows/Linux evidence does not qualify this expanded whole tree;
full combined native/package and independent-review gates remain open. The pre-existing untracked
note, published main/tag, PR bases and installed app were untouched. No new worktree or public PR.

## Locked Linux check of the closed combination — 2026-09-12

The existing isolated 5070 dependency checkout now runs exact commit
`4d116b0e43fb2f551b5c8e870d89715593934cf3`, tree `9f49c3ea5c2899ef86363994d1dc26c840f39a44`.
The transfer bundle's SHA-256 was verified before fetching, and checkout preserved the two existing
untracked synthetic audit/test logs. Actual dependency resolution is js-yaml 4.3.2 / Acorn 8.18.0;
lock SHA-256 remains `dc03ba243406af81e4e01587e765c24b20c94e79781b7713a0238f5d3903e223`.
Linux Node passes **1,498 tests, 14 platform skips, zero failures (1,512 total)**; architecture and
governance checks also pass. No dependency install or manifest/lock change occurred. The exact-run
log remains in the remote checkout's local Git metadata, outside the source tree.

This closes the Linux locked-dependency source-test omission for that combination, not Windows
whole-tree acceptance, native distribution packages, signing, independent review or migration.
Published 2.0.2 and all GitHub branches/settings remain unchanged; temporary transfer files are
removed after verification while the reusable remote checkout and dependency cache remain intact.
