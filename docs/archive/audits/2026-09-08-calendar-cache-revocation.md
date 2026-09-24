# Calendar cache authorization and request retirement

- Status: Historical source acceptance; not an installed-app or release receipt
- Owner: Desktop / campus-data maintainers
- Verified: 2026-09-08
- Behavior baseline: `86a245c0ff0b2f2b861ac5994c19f54eec8ab83d` (PR #106)
- Behavior repairs: `5c3a15a`, `7982a91`, `5f1b430`; strengthened prior assertions: `f1a8a54`
- Combined Renderer-chain acceptance: `3b9511f75e865bbd61696fb355208795e88aa209`

Offline regressions reproduced three problems: authoritative denial of one week left other week
caches usable; a late week denial was ignored after date navigation; and an older generic load
could restore personal schedule data after revocation.

Main now invalidates week caches and older publication rights on a signed-out, session-expired
or forbidden calendar result while returning that authoritative denial. Empty signed-out status
snapshots remain cacheable to avoid repeated SSO probes; forced refresh still rechecks them.
Starting a fresh full source read establishes a new generation, so older responses (including
denials from before revalidation) cannot overwrite or invalidate the new result.

Renderer treats date selection and display authorization as different lifetimes. A denial from
an earlier week in the same display context revokes the current calendar cache, stops automatic
refresh and fences pending publication. Replies from a cleared/replaced display context are
ignored. Explicit full revalidation supersedes older week responses. Normal network failure
continues to retain last-good data; authoritative denial does not masquerade as an offline error.

The behavior remains in #106, and the same rules were ported into #108's native controller and
carried through #109/#110 without restoring the legacy global module. No public API, cache file,
Profile/Workspace schema, credential store or system network configuration changed. Superseded
full reads reject with the existing PORTAL_CONTEXT_CHANGED code; their previous cache-protection
tests now also require rejection instead of accepting an unusable stale result.

Evidence on the combined chain:

- RED cases failed before repair, including leftover cache count, stale data restoration and a
  late old denial invalidating fresh full revalidation.
- Mac focused cache/date/runtime tests passed (30 plus 8 context-retirement assertions).
- Windows 5070 native RBMS SSH / Node 24.20: all 38 focused tests passed.
- Linux 5070 complete Desktop suite: 1,323 passed / 6 platform skips.
- Native Mac/Windows schedule navigation and computed-style comparisons passed, including
  expiry removing displayed events and a subsequent explicit refresh recovering them.
- 96 rendered-state comparisons between legacy and native-module versions remained equal.
- Architecture, install-script and syntax checks passed; no budgets or dependencies were raised.

Initial full-suite failures caught loss of signed-out status caching and old assertions that
allowed superseded full-read results to be returned. Status-only caching was restored; retirement
assertions were strengthened. This receipt reports the final successful rerun, not those failures
as passes. Windows GPU exit 34 warnings remain.

No real-school login, API probing, full Windows suite, package/signing, long soak or public release
was performed. The installed Mac app is unchanged at ASAR
705d83f90356cf3b1973d723f4d785765cba4adbba53843394d32c5a013baf0c; these additional fixes are review
source only. Rollback to the behavior baseline needs no user-data migration but restores the
reproduced cache defects. Preserve the already delivered compact pending-week UI when reverting.
