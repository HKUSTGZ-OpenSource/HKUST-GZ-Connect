# Desktop download dependency maintenance

- Status: Proposed local maintenance evidence; not merged or released
- Owner: Desktop maintainers
- Last verified: 2026-10-03
- Applies to: PR #205 candidate based on `main@7e86a41451f0788e09e8a9e4f505885c59744119`

## Remaining security finding

An online npm audit of the committed PR #205 lockfile reports eight high package findings,
zero critical findings, propagated from one
[http-cache-semantics advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp).
The dependency chain is app-builder-lib 26.17.0 -> @electron/get 3.1.0 -> got 11.8.6
-> cacheable-request 7.0.4 -> http-cache-semantics 4.2.0.
Published http-cache-semantics versions currently end at 4.2.0. Do not apply npm's proposed
breaking builder downgrade, bypass the audit or describe the existing required check as green.

## Why a download-library override is not a safe fix

The installed builder constructs Got-style `agent` and `timeout.request` options. @electron/get 5
uses fetch options instead. An isolated negative experiment replaced only the builder's import
with the existing @electron/get 5.0.0; it did not edit dependencies or use a real profile.
Checksum validation and cache reuse passed, but the process-local HTTP proxy failed and a stalled
download outlived its configured request deadline until the fixture watchdog terminated it.
An audit-only override would therefore trade the vulnerability for broken build-network behavior.

The [upstream builder download implementation](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/src/util/electronGet.ts)
has corresponding changes for proxy initialization, AbortSignal deadlines and fetch error retries.
Registry metadata lists 27.0.0-alpha.9 with @electron/get 5, but it also upgrades multiple packaging
dependencies. That is an unaccepted prerelease build-tool migration, not a patch-level override
or a verified cross-platform replacement. Keep it separate from runtime Electron platform support.

## Regression contract

`desktop/test/contracts/packaging/builder-download-compatibility.test.js` invokes the actual
installed builder in fresh child processes. All mirrors and proxies bind loopback; all artifacts
are synthetic nonexecutables and caches use newly created temporary directories. Every child
uses a unique synthetic artifact version: builder's global per-version lock otherwise lets an
intentionally stalled negative experiment block an unrelated positive fixture or actual build.
One concurrent full-suite run exposed this fixture-isolation failure; the fix separates identities
without raising any deadline or changing production dependencies.

The seven checks cover valid SHA-256/cache reuse, mismatched SHA-256 rejection, actual proxy receipt,
bounded rejection of a stalled request, transient 503 retry, permanent 404 rejection and corrupted
cache revalidation. The loopback proxy supports both absolute-form HTTP and CONNECT requests;
it serves synthetic bytes locally and never forwards a connection to an external target.
Process-local environment values are synthetic;
installed Clash, system proxy, credentials, application data and school sessions are not accessed.

Run from `desktop/`:

```sh
node --test test/contracts/packaging/builder-download-compatibility.test.js
```

The existing 26.17.0/3.1.0 pair passed the initial four checks and the expanded seven-check
contract locally on macOS with Node 25.9.0.
The opt-in negative experiment is reproducible with:

```sh
HKUST_TEST_GET5_CANDIDATE=1 node --test test/contracts/packaging/builder-download-compatibility.test.js
```

The negative mode must fail proxy/deadline checks with the incompatible override; it is not the
normal validation command, an accepted configuration or a live-network acceptance result.
Native Node 24 and Windows/Linux evidence, full final-tree gates and package acceptance remain
separate requirements for any eventual dependency migration.

## Isolated upstream migration evaluation

The published npm package `electron-builder@27.0.0-alpha.9` was installed with scripts disabled
in a newly created temporary directory, never into the product worktree. Its published integrity
is `sha512-m8rWfMud2yvJJHWiB9mZN6kpb30nuw5QvqCqYs1BGLMk9sqSphs3UjhS9KWaLbkCYGp0CYm0aDFUx0BI0gLxWg==`.
No upstream Git commit is asserted: registry metadata supplied no gitHead, and the matching GitHub
release URL was unavailable. The package repository metadata points to the official builder project.

The final temporary manifest uses all PR #205 devDependencies/overrides except the exact builder
prerelease pin. Its lockfile SHA-256 is
`2b2069a70b43c37f8bbf20e8587263fecd026d920dbbf1e43851a8e2e7475d23`.
Electron resolves to 43.7.7, the download library to 5.1.0, and the old got/cacheable-request/
http-cache-semantics chain is absent. Online npm audit reports zero findings for that temporary
211-dependency graph; its lock records no dependency install scripts. This does not change the
audit result or dependency declarations on the actual PR head.

The expanded seven-check contract also passes against that temporary builder. Opt in using the
absolute path of a newly created `hkust-builder27-evaluation.*` package root:

```sh
HKUST_TEST_BUILDER27_ROOT=/absolute/temporary/hkust-builder27-evaluation.example \
  node --test test/contracts/packaging/builder-download-compatibility.test.js
```

This fixture uses the new vendor download helper's `options` shape and AbortSignal deadline in
an internal test seam. It does not claim legacy Got download options remain compatible, or that
arbitrary download options are accepted by the public CLI schema. The core test isolates the
proxy environment from the real process, and enforces a parent watchdog for stalled downloads.

The current product build configuration validates under the new builder, and its CommonJS
afterPack function resolves successfully without invoking signing/credential effects. A separate
minimal synthetic macOS arm64 application packaged with Electron 43.7.7, executed a CommonJS hook,
contained the expected ASAR entries and launched to its completion marker using a temporary
userData directory. That app had no production dependencies, Engine, network request or student
data. Its generated bundle was moved to Trash after confirmed process exit and no open handles;
it remains recoverable and no storage-space reclamation is asserted.

These are macOS Node 25.9.0 compatibility findings, not full-app, Windows/Linux, Node 24, signing,
installer, upgrade or published-release acceptance. ESM conversion, changed config/signing APIs,
new packaging dependencies and the prerelease status still require explicit migration review.
No prerelease is adopted automatically, and no audit gate is bypassed.

## Acceptance and rollback

Before adopting a replacement, require a reviewed upstream-compatible implementation, online
exact-lock audit, these download contracts, install-script/license review, full source gates and
exact-source macOS/Windows/Linux package evidence. Do not switch to Electron 44 to solve a
build-only problem or silently adopt a prerelease in stable release jobs.

The current local addition is tests/evidence only. Removing it does not require a user-state,
credential or persistence migration; immutable published tags and the installed application are
unchanged. PR #205 and dependent PRs remain unmerged while required checks fail.
