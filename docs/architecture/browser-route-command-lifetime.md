# Browser route-command lifetime

- Status: Proposed M2 source repair; exact-head/native/package acceptance required
- Owner: Desktop maintainers; accountable maintainer heeh02
- Last verified: 2026-10-04
- Applies to: post-v2.0.3 source after `main@408dacffdb618a450cb159b3659a21ed120bc401`, not released/installed behavior
- Supersedes: unbound late rule submission and Session reconfiguration in Browser `setTabRoute`

## Boundary and preservation

`BrowserRouteCommandOwner` admits the existing per-tab route command through the existing Session
entrypoint. It calls the original rule transaction, normalization, readiness, PAC, navigation and
page presentation authorities. It does not add a second rule store, route resolver, Session,
connection state, IO queue, credential algorithm or system-network policy.

Before command admission, the original page must be live. The owner captures its page admission,
navigation intent and rule-policy identity, clears staged credential evidence as before, then
revalidates before submitting IO after campus readiness. Closed/replaced windows, retired
contexts/tabs, changed documents, superseding navigation and replaced policy cannot submit a late
rule. The existing page and navigation owners supply these decisions; the command does not infer
them from DOM, URL text or process names.

Once the original store accepts IO, its completion may finish. This repair does not cancel or
roll back an already-accepted write. Successful completion can retain the existing `true` return
after retirement, but cannot start further local PAC configuration, page effects or toolbar
feedback. Current failures keep their original cause; retired failures are quiet `false` results,
not failures shown in a replacement Profile/window. Reentrant retirement in synchronous credential
or route projection effects also fences a subsequent readiness/effect call.

Document revision is checked before storage admission. After acceptance, ordinary PAC activation
may itself load the same owned page; that revision alone does not cancel its accepted command.
Its original live page/window/context, navigation intent and policy must still be current. This
distinction preserves the current same-view reload/error retry behavior.

Route semantics remain: `auto` removes only the exact personal override; `direct`/`campus` upsert
the original exact host; includeSubdomains remains false. The transactional policy's
`appliesLiveSession` avoids duplicate local configuration. Other policies keep the existing force
configure and port fallback. Effective campus routes still wait for readiness before reload.
The same WebContents, cookies, history, POST state and native MFA relationship remain owned by the
original modules. No wire, persisted schema, credential storage or new public IPC.

## Evidence and limits

Three actual production-fixture RED cases failed on the baseline: a closed tab still submitted a
rule after readiness; accepted write completion still configured a replacement window; retired
readiness rejection escaped instead of remaining quiet. Three rooted regressions plus11 owner
cases cover valid/invalid/workspace input, exact-host direct/auto transactions, page/context/policy/
navigation retirement, accepted IO, current versus retired failures, PAC-induced revision change,
effective-campus wait, same-page failed-URL retry and reentrant effect retirement.

Real Electron uses only its intercepted synthetic HTTPS page and in-memory policy: a closed tab's
late readiness submits0 rules; an already-accepted write finishing after close configures0
Sessions. The marker is `native Browser route command retirement: PASS`. Prior route dropdown,
toolbar/page/viewport/credential/teardown, compact/standard/wide, keyboard and active-view checks
remain. No GUI/CSS/motion change or new layout budget.

Final local complete suite:2,062 cases,2,046 pass,16 platform skip,0 failure. Native toolbar,
password/popup MFA, strict proxy, routing restart, tab retirement, Main integration, Profile
switch/relaunch and migration exit0 pass on this batch. After reentrant hardening, complete suite,
toolbar and performance were rerun; final offline20-tab/100-switch p95 1.2ms/max5.3ms,30/30 soak
views retired and terminal tab/view/timer residue0. These are synthetic/offline measurements, not
Gateway performance, a live-school canary or original Windows reporter reproduction. The sole
intermediate full-suite failure was the old90-debt count assertion; its check now requires89 and
absence of the specifically retired edge, without weakening the public i18n contract.

Browser897->871/class740->714; command owner75. The co-located Session file is not claimed sub600.
Main662/20 direct/35 effective/170 transitive unchanged. One genuine Browser-root private rule-store
edge is removed; static JS debt/cap90->89 while the existing Session-to-rule-store debt remains
visible. Production graph remains240 nodes and edges452->451. No new dependency or raised budget.
Teardown, Session activation/configuration and myPortal class bodies remain baseline-identical.
Remaining Browser creation/open/composition, M1/M5, original reports and full goal stay incomplete.

## Unreleased note and rollback

Closing or superseding a campus-browser page while a route change waits no longer submits a late
personal rule or reconfigures another window. Accepted writes retain their original storage
ownership. This is unreleased source, not part of immutable v2.0.3 or an installed-app update.

Revert command owner/delegate, contracts/native fixture, retired edge/downward caps and docs
together. No migration; rollback restores reproduced stale-route side effects. No installed
application, active Clash/profile/controller/system proxy/TUN/DNS/route mutation, real credentials,
private Gateway evidence, release or tag operation.
