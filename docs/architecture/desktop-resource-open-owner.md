# Resource library source and open ownership

- Status: Proposed bounded M3 extraction; not full Main composition
- Owner: Desktop Resources maintainers
- Last verified: 2026-09-29
- Applies to: candidate based on development `main@b528809276bb00bcbcf1eb3ca83c66952e6c829b`, not published v2.0.3

The existing `ResourceLibraryRuntime` owns two formerly Main-local resource operations. Its
source adapter merges the active School Profile's custom and hidden resource settings and
projects the effective route through the injected Routing policy resolver. Profile merging and
route selection remain with their existing owners; Resources does not create another routing
policy. If settings or route projection fails, the adapter reports the failure and returns the
same Profile-only fallback without guessing an effective route.

Opening a resource by ID now enters the existing active-context transaction through an injected
callback. The runtime resolves the ID, checks the active context, opens through the Browser
request callback, records activity only after success and returns the same localized result.
Main still constructs the Runtime, injects those ports, and registers the existing Browser and
IPC callbacks. No URL-taking IPC method, new Renderer API, persisted field or credential access
is introduced.

At this candidate, Main falls from 831 to 819 lines. Its 30 direct / 44 effective / 170
transitive dependencies are unchanged; no architecture budget is raised. The below-800/24 and
final M3 targets remain open. Synthetic tests cover Profile merge, effective route, settings
fallback, context transaction, locale and failure behavior. They do not prove a live school
opening or installed application behavior.

Rollback the Resources runtime, Main wiring, contract tests and this record together. The
published v2.0.3 artifacts and user data are untouched.
