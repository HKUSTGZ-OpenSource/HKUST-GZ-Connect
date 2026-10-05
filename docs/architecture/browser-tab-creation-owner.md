# Browser tab creation admission

- Status: Proposed M2 extraction; exact-head/platform acceptance required
- Owner: Desktop maintainers; accountable maintainer heeh02
- Last verified: 2026-10-05
- Applies to: post-v2.0.3 source after `main@8a493fa63fa38e73ad4f3da253253a0d6f7bc11a`
- Supersedes: page/Workspace creation admission algorithms in the Browser root

## Responsibility

`BrowserTabCreationOwner` owns the synchronous entry decision for a page or local Workspace:
context/window availability, tab capacity, URL normalization, existing Workspace reuse,
shared Session selection and delegation to the existing tab resource owner. It is co-located
in the existing Browser Session entrypoint; no production dependency node or second policy
implementation is added.

It does not create native views, allocate IDs, register page events, own cookies, perform
navigation/routing activation or retain a tab registry. `BrowserTabLifecycle` remains the
only native page/Workspace lifecycle owner and preserves its existing creation/rollback/
cleanup code. Window, navigation, route, credentials/MFA and Engine remain independent.
The admission owner has no mutable lifecycle state or timers; repeated calls after retired,
destroyed or missing window admission are inert. Real resource cleanup remains elsewhere.

## Preserved ordering

- Generic page entry checks capacity before normalization, including local blank URLs.
- Explicit blank-page options bypass normalization but remain page creation.
- Local blank entry retains the Browser's Workspace facade.
- Direct Workspace entry reuses the exact existing tab before capacity and Session checks,
  selects it before sending state, and returns that original identity.
- New pages of either route use the original shared Browser Session; missing Session prevents
  route/native allocation. Route resolution still belongs to its existing policy owner.
- Original options, credential reservation, target-window and Session identities pass through
  unchanged. Errors retain their existing text and Root receiver; an absent observer does not
  evaluate the limit translation.

Dynamic getters preserve live translator, workspace controller, error observer and settings
bindings rather than capturing a stale constructor snapshot. Root's `createTab` and
`createWorkspaceTab` remain small delegating compatibility methods, without duplicate policy.

## Evidence and acceptance

Four new rooted contracts pass on the unmodified baseline before movement. One initial test
incorrectly expected null from a deliberately throwing capacity spy; it was corrected to assert
the original exception and switch/state order before extraction. This is preservation evidence,
not a newly fixed production failure. A fifth rooted contract preserves facade and callback
receiver behavior. Ten independent owner cases cover ordering, identities, error behavior,
Workspace reuse, Session absence, repeated retired admission and invalid dependencies.

Real Electron exercises Workspace reuse at capacity, blocked page admission without ID growth,
invalid URL without allocation, and an actual accepted page with the same shared Session and
expected next ID. Marker: `native Browser tab creation admission: PASS`. Existing entry/route/
credential/page/viewport/teardown, compact/standard/wide and keyboard contracts remain required.

Complete Desktop, exact-tree syntax/secret/architecture/governance, native MFA/strict proxy,
Profile/relaunch/migration, routing, tab retirement and offline performance tests precede the
single remote batch. Exact-head required CI, three-platform packages and actual-final-main
verification are separate mandatory acceptance gates. Synthetic/native evidence is not live
school, original Windows report or Gateway latency/access qualification.

Browser source855 ->842/root class697 ->683; new admission owner57, original native tab module570.
Production graph240/451 and Main662/20 direct/35 effective/170 transitive stay unchanged.
JS inventory-only private-edge cap89 is unchanged; root-test debt stays zero. The Browser growth
ratchet lowers to842, not the full M2 exit target. Remaining composition and M1/M5/governance/
reporter requirements remain open.

## Risk and rollback

This extraction adds no persisted schema, wire DTO, Renderer symbol, dependency or budget
exception. Revert owner/delegates/tests/native fixture/downward ratchet/docs together; no data
migration is needed. It restores the old Root-owned admission implementation, not a new route.
No installed-app update, immutable release/tag change, private/student fixture, live school
canary or active Clash/system proxy/TUN/DNS/route operation is performed.
