# Browser open-request lifetime

- Status: Proposed M2 source repair; exact-head/platform acceptance required
- Owner: Desktop maintainers; accountable maintainer heeh02
- Last verified: 2026-10-04
- Applies to: post-v2.0.3 source after `main@abf8b5bcc814ccd0252a94c224c1a7d269af0cf9`, not installed/released behavior
- Supersedes: pending open/Workspace continuations surviving ordinary user window close

## Ownership and boundaries

`BrowserOpenOwner` owns only entry-request retirement in the existing Session entrypoint.
Window creation/readiness, tab identity, navigation, routing policy, configuration, cookies,
credentials/MFA and Engine remain with their existing owners. No second Session, connection
state, rule store, IO queue, timer, generic IPC or Renderer symbol is added.

An open captures the entry epoch and current context before readiness/configuration. Explicit
ordinary close and confirmed native close retire that epoch before independent cleanup; context
retirement additionally fails the existing context predicate. The teardown coordinator attempts
this notification inside its existing failure aggregation, so notification failure cannot skip
credentials/pages/native close. Initial window creation does not retire concurrent open requests;
they still share one owned toolbar-load promise.

The existing routing admission gains an optional current-entry predicate, defaulting to true
for unchanged navigation callers. A retired entry cannot begin late readiness/activation or
report readiness after retirement. Session IO already accepted by its owner may finish; no
fake cancellation/rollback or engine-stop behavior is invented.

Before an explicit new request, a physically destroyed but unobserved old window is cleared
through the existing window owner, then the new epoch is captured. This preserves ordinary
explicit reopen without allowing an old pending request to implicitly recreate the window.
After show/selection/state/tab effects, original epoch/context/window are revalidated.

Current shared toolbar-load failure keeps its exact original cause for original waiters while
no replacement/context change intervenes. A single bounded failure reference distinguishes
automatic failure cleanup from user retirement; user retirement clears that reference and
notifies the Manager. No error-string inference or unbounded failure history.

The Manager's existing private open epoch receives a Browser-affine retirement notification.
It fences pending connection waits, outer feedback and bookmark-manager focus without changing
wire DTOs. A private `BROWSER_OPEN_RETIRED` cause becomes the existing quiet stale outcome;
current failure feedback is preserved. Notifications from a replaced Browser cannot retire the
new Manager instance's requests.

## Evidence and corrections

Four actual baseline REDs cover native close during campus readiness, windowless ordinary close,
Workspace configuration completing after ordinary close, and Manager readiness/feedback after
native retirement. The initial activation spy bound the facade recursively; it was corrected to
bind the actual original activation owner before counting the native-close case as valid RED.

Rooted/owner/Manager contracts cover current opens, blank/local home, Workspace reuse, invalid
ports/ports validation, context/readiness/configuration/show retirement, current versus retired
failures, shared load failure identity, explicit reopen, concurrent shared creation, reentrant
selection, notification failure, replaced Manager and optional routing admission. Intermediate
existing regressions exposed ordinary reopen and primary-load-failure preservation; production
was corrected without weakening their assertions or budgets.

Real Electron uses its intercepted synthetic HTTPS page: readiness is actually pending, the
original native window closes, late readiness produces the retired cause with0 activations,
no replacement/tabs, and the same independently owned Session remains. A later explicit
Workspace open succeeds. Marker: `native Browser open request retirement: PASS`. Prior toolbar,
route/credential/page/viewport/teardown, compact/standard/wide and keyboard/accessibility checks
remain; no GUI/CSS/motion change.

Final local complete suite2,082 cases:2,066 pass,16 platform skip,0 failure. Native toolbar,
Main integration/network startup, Profile/relaunch, migration exit0, password/popup MFA, strict
proxy, routing restart, tab retirement and offline performance pass on this batch.20-tab/
100-switch p95 1.1ms/max2.6ms;30/30 soak views retired and terminal tab/view/timer residue0.
These are source/synthetic/native findings, not original Windows/portal or real Gateway results.

Open owner88, teardown80, routing admission58; Browser871->855/class714->697. Shared Session
file is not claimed sub600. Main662/20 direct/35 effective/170 transitive and JS debt89 unchanged;
no production graph node, dependency or raised budget. Remaining Browser creation/composition,
M1/M5, original reporter tests/deferred governance and the full goal remain unfinished.

## Unreleased note and rollback

Closing the browser cancels older pending opens instead of allowing late connection readiness
to reopen it; later explicit opens still work. Existing cookies, shared window loading and
current failure messages remain. Source only, not immutable v2.0.3 or installed-app replacement.

Revert entry owner/delegates/retirement ports/Manager affinity, regressions/native fixture,
downward ratchet and docs together; no migration. Restores reproduced stale-open risk. No real
credentials/private Gateway, active Clash/system proxy/TUN/DNS/route, release or tag operation.
