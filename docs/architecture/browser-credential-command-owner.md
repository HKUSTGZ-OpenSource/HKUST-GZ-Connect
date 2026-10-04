# Browser credential command owner

- Status: Proposed M2 source contract; exact-head/package acceptance required
- Owner: Desktop maintainers; accountable maintainer heeh02
- Last verified: 2026-10-04
- Applies to: post-v2.0.3 source after `main@22d69286a13aed98a1e1b2177f3d3b4389455941`, not installed/released behavior
- Supersedes: saved-account command and approved shared-login delivery inside `CampusBrowser`

## Boundary

`BrowserCredentialCommandOwner` is a distinct 147-line class beside the existing credential/MFA
owners. It owns per-tab manage/fill flights and temporary plaintext projections, not authentication
evidence, OTP detection, password-saving approval, encryption, vault serialization, Sessions or routing.
The existing `CredentialController` and `ManagedCredentialPopupOwner` class bodies are byte-identical
to the accepted baseline; vault/preload/Engine/schema sources are unchanged.

Page admission comes from `BrowserPagePresentationOwner`: exact current window/WebContents/tab,
observation revision and the existing Navigation owner's intent. It observes that intent, never
mutates or reimplements it. Commands additionally bind canonical HTTPS origin, vault/dialog identity
and their reset generation. These Main-only records do not become Renderer handles or generic IPC.
Browser facades preserve manage's void result and shared-fill's boolean result; messages, buttons,
fill channel/payload, approved provider selection and ordinary user actions remain compatible.

## Lifetime

- Repeated manage/shared commands join one current per-tab flight. A superseded completion cannot
  erase its replacement. Separate manage/fill maps do not cancel one another's valid operation.
- Admission is checked before lookup and after every asynchronous lookup/dialog return, before
  prompt/fill/delete and again inside shared-owner string access. Removed pages, new same-origin
  documents, changed origins, replaced windows/vaults/dialogs, retired contexts and reset are inert.
- Loading/navigation/fragment observation retires the old commands; window/tab close and reset do
  likewise. Acquired vault projections are cleared immediately on explicit retirement and in final
  completion; a dedicated IPC copy preserves normal delivery before clearing mutable source fields.
- Acquired shared owners are destroyed on success, invalid shape, stale completion, reentrant
  retirement and errors. Destruction failure remains inactive/owned for retry and is not reported
  as confirmed success. Plain JavaScript strings cannot be cryptographically erased; this does not
  claim process-memory erasure beyond the existing zeroizing shared-owner contract.
- Vault deletion is accepted only after a current user choice and remains bound to that captured
  vault/origin. An already accepted storage operation can complete; no cancellable vault IO or
  persistence-policy rewrite is invented here. Password-saving evidence/prompts remain separate
  existing controller work and are not falsely declared fully audited by this slice.

## Evidence and current scope

Two actual baseline Browser regressions were red with synthetic data: delayed shared lookup could
issue an old-document fill, and stale vault lookup could open the old-origin dialog after navigation.
The fixes deny Main dispatch; the existing Preload origin/OTP guard stays intact. This is not a claim
of real credential theft or an authorized real-school canary.

Eleven direct command contracts cover success/copy/cleanup, origin-bound deletion, missing/HTTP
behavior, lookup/dialog retirement matrices, duplicate shared delivery, stale owner destruction,
replacement flight identity, reentrant reset, malformed/failed cleanup and current-only error feedback.
Browser/Page integration contracts exercise actual facades and owned revision/intent admission.
Final local full suite: 2,022 tests, 2,006 passed, 16 platform skips, zero failures.

The native toolbar fixture uses intercepted synthetic HTTPS pages and deferred in-memory providers/
dialogs: actual page navigation invalidates both commands, duplicate shared lookup occurs once,
stale strings are never materialized, acquired owner destruction is once, and held plaintext clears
before the old dialog completes. The initial fixture accidentally selected a local blank tab; it
was corrected to its own intercepted HTTPS tab without raising deadlines or changing production.
The first remote native run exposed a second fixture assumption: replacement-page dom-ready may
legitimately start a fresh lookup. The deferred provider now belongs only to the captured old
document; replacement lookups return null, the original duplicate check happens before navigation,
and bounded replacement work drains before the zero-residue assertion. Production source is unchanged.
The first static credential source check was updated to retain nested finally-cleanup requirements.

Local native toolbar, popup/password MFA, strict proxy, tab retirement, routing restart, Main
integration, Profile switch/relaunch and migration command exit0 pass. Synthetic 20-tab/100-switch
performance: p95 1.7ms/max8ms;30/30 soak views retired and terminal tab/view/slow-timer counts0.
These are offline/private-fixture observations, not Gateway latency, Windows GUI or live login proof.
Exact-head three-platform package/native CI and final-main acceptance remain required.

Browser968->921/class812->765, hard cap ratchets downward. Main662/20 direct/35 effective/170
transitive and global JS debt90 stay unchanged; no production graph node/dependency or budget added.
The credential file643 includes command147/controller312/popup154 as separate owners, not a claim
that the whole file is below600. Browser/Page root composition and candidate-saving lifetime still
need independent review; #80 and the full repository goal remain open.

## Draft user-facing release note — unreleased source only

Saved-website account operations and approved shared-login delivery now stop when their original
page/window is retired. Rapid repeated actions are coalesced; stale dialogs cannot fill or delete
for a changed page. No settings migration, new login method or broader credential-sharing scope.
This item is not in immutable v2.0.3 and requires a separately authorized exact-source release.

Revert owner/facades, admission/reset hooks, contracts/native fixture and downward cap together.
No data migration, installed-App/active Clash change, publication or live credential access occurs;
rollback can restore the demonstrated stale-dispatch risks.
