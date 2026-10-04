# Browser credential save lifetime

- Status: Proposed M2 source repair; exact-head/native/package acceptance required
- Owner: Desktop maintainers; accountable maintainer heeh02
- Last verified: 2026-10-04
- Applies to: post-v2.0.3 source after `main@654ef845b2dd0792a246c898e54bf2b5b5e86aa2`, not released/installed behavior
- Supersedes: unbound asynchronous save prompting inside the existing `CredentialController`

## Scope and authority

The existing credential controller owns staged candidates, successful-page/MFA evidence and one
password-save approval per origin. This repair gives its already-existing approval an explicit
lifetime; it does not infer new authentication success, change accepted response codes, OTP/form
classification, shared Session/opener/postMessage/self-close behavior, vault encryption/schema or
credential-sharing scope. Existing command/popup owner class bodies and protected vault/Preload/
Engine sources are unchanged. Root HTTPS-tab-origin projection moves behind the credential module
with a compatible facade, not a new production dependency node.

An admitted approval captures exact original native window, vault/dialog identity, owner tab (when
the recognized login evidence supplied one), context and reset generation. The production Browser
injects current opaque context/tab membership; standalone legacy controller consumers retain their
existing optional-port defaults but still get exact native-window ownership. No generic IPC or
Renderer handle exposes these records.

## Lifecycle and preservation

- Candidate input password is transferred immediately to one owned approval record and erased
  from the caller object. Invalid/duplicate inputs are erased too; same-origin duplicate behavior
  and existing user consent messages/actions remain unchanged.
- Lookup and dialog completion revalidate original authority before prompt/save/feedback. A
  retired window/tab/context or replaced store/dialog cannot cause a new prompt or save. Tab clear,
  close/reset and context retirement erase held approval secrets; old completion cannot clear a
  replacement same-origin prompt. Ordinary reopen may create new operations.
- Reset clears all staged candidates, their timers and linked popup ownership, and invalidates
  approvals before other resources close. A cancelled candidate timer checks its exact candidate
  identity rather than clearing a replacement. Timer cleanup failure still erases every staged
  secret and attempts other records; failed timer ownership stays retryable/unconfirmed.
- Successful login evidence still belongs to the existing controller; a completed native MFA popup
  may close while its original owner tab approves saving. Approval is bound to that owner tab, not
  incorrectly cancelled by the legitimate popup self-close.
- A current user-approved save is handed to the original captured vault/origin. Once accepted,
  storage IO may finish; no cancellable vault API is invented. Reset after acceptance prevents a
  current-success return/feedback, not a false assertion that the accepted IO was rolled back.
- Plain JavaScript string clearing is lifecycle hygiene, not a cryptographic memory-erasure claim.
  No raw credentials, OTPs, cookies, personal evidence or private Gateway observations were used.

## Evidence

Two actual baseline synthetic tests first failed: delayed lookup prompted in a replacement native
window; confirmation after original window destruction still saved. Ten added lifetime tests cover
those cases, tab/context/vault/dialog/reset matrices, immediate secret retirement, same-origin
replacement completion, staged/popup reset/reuse, already-accepted save completion, quiet retired
errors, cancelled timer identity and ambiguous timer cleanup. Existing post-login/SPA/challenge/
HTTP-failure evidence and consent checks remain. Final local complete source suite:2,032 cases,
2,016 passed,16 platform skips,0 failures.

Actual native toolbar uses its intercepted synthetic HTTPS tab, deferred in-memory vault/dialog
and owned native tab closure: old lookup never prompts, an acquired approval password clears before
old confirmation returns and neither old operation saves. All prior credential-command, page/
viewport, compact/standard/wide, keyboard and active-view accessibility assertions remain.
Native popup/password MFA, strict proxy, tab retirement, routing restart, Main integration,
Profile switch/relaunch and migration command exit0 also pass on the same batch. After timer-hook
hardening, native toolbar/MFA/strict proxy/performance were rerun. Final synthetic20-tab/100-switch
p95 1.3ms/max5.4ms;30/30 soak views retired, terminal tab/view/slow-timer residue0. These are offline
private-fixture measurements, not Gateway performance or original Windows/login reproduction.

Current owners: command147, credential371, popup154; shared file711 is explicitly not a sub600 file.
Browser921->919/class765->763 and its cap ratchet down; Main662/20 direct/35 effective/170 transitive
and JS debt90 unchanged. No production node, dependency, budget, wire or schema added. Whole Browser
composition, M1/M5, original reports and full repository goal remain incomplete.

## Unreleased user-facing note and rollback

Saved-website password approval now stops with its original tab/window/context; stale confirmation
cannot save after retirement. Existing successful-login evidence and explicit user consent remain.
This note is source-only, not part of immutable v2.0.3, and does not authorize a release.

Revert controller lifetime, Browser hooks/origin facade, contracts/native fixture, downward cap and
documentation together; no migration. Rollback restores reproduced stale-approval risks. No
installed-App/active Clash/network mutation, real-school canary or release/tag operation occurs.
