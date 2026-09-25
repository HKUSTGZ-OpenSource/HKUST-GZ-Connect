# Browser tab lifecycle owner

- Status: M2 tab-view owner and retirement-guard boundary; not a release
- Owner: Desktop / Browser maintainers
- Last verified: 2026-09-25 (current-main integration, local fixtures)
- Applies to: `BrowserTabLifecycle` in `desktop/lib/browser/tabs/tab-manager.js`
- Scope: M2 tab-view creation, attachment, selection, rollback and cleanup; not complete Browser modularization

## Ownership

`TabManager` retains the existing pure collection/ID API. `BrowserTabLifecycle` extends that model
within the same tabs-domain module and owns:

- page and Workspace native-view creation, preserving the supplied Electron Session identity;
- one attached active view, layout-before-show, detach-without-destroy for background tabs;
- selection rollback and failed-creation cleanup without recycling tab IDs;
- closed-tab renderer cleanup, last-tab replacement requests, and repeated view teardown;
- the active and attached native-view references.

`CampusBrowser` keeps route/URL validation, Session selection, credentials/certificate algorithms,
window orchestration, page-event binding and toolbar presentation. It injects named effects and
window/workspace accessors, not the whole Browser object. The `view` and `attachedView` compatibility
accessors remain for existing callers and diagnostics; native lifecycle mutations belong to the
tabs owner. Workspace focus and loading behavior are preserved by this structural change.

This reuses the existing module rather than adding a wrapper or increasing Main's dependency cap.
On the current base, `CampusBrowser` falls from 1,804 to 1,627 lines; the tabs module is 397 lines. Architecture checks
freeze the reduced Browser limit and enforce a 600-line ceiling on the tabs owner module. Main's
36 direct / 170 transitive dependency limits remain unchanged.

## Preserved boundaries

Native views use the same preload and Session, with node integration and DevTools disabled,
context isolation, sandbox, web security, safe dialogs and background throttling unchanged.
Credential reservations and tab cleanup remain delegated to the existing credential controller.
No cookie, password, OTP or token is copied to a new store or display DTO. Managed MFA popups remain
native children owned by the existing popup path; they are not turned into tabs.

The structural commit intentionally does not change routing, login or late asynchronous Workspace
completion semantics. Any newly reproduced stale-completion defect must be fixed and reviewed as
a separate behavior change, rather than hidden in this move.

### Separate context-retirement correction

The follow-up behavior change fences Workspace completion, failure and crash reload against both
the original native window and the still-owned tab object/view. Retired work neither sends state,
delivers deferred focus nor updates/errors the new Browser. Construction rollback cannot attach an
old-session view to a replacement window, and an abandoned page creation cannot report into it.
Closed renderers are still released; valid current-window completion and ordinary failure reporting
remain unchanged. Four late-result regressions and a replaced-window reporting regression were
observed failing before the guards; a real Electron view-retirement fixture complements the unit
cases. This is not a live campus or MFA-provider test.

The additional completion guard captures the Workspace controller identity, checks retirement
again after injected state/focus effects, and drops a pending focus request if its tab is now in
the background. Background data may still finish loading; it must not steal focus from the newly
selected tab. Three additional unit regressions failed before this correction. The native-view
fixture covers both retirement and completing a background Workspace while another view is attached.

## Verification and rollback

The original 57-test comparison is historical candidate evidence. Current direct owner tests
cover hardened view preferences and Session identity, a single attached active view, attachment
failure rollback, a replaced host window, repeatable close, last-tab replacement, clamped bounds
and deferred Workspace focus. Real Electron Browser toolbar, popup MFA, strict-proxy and performance
fixtures provide separate local runtime evidence; none is a real-school acceptance test.

Revert the extraction and its associated tests/ratchets together to restore the prior class layout.
There is no persisted schema migration, native binary change, automatic system-network mutation or
installed-App replacement. Remaining M2 owners and the final sub-600-line Browser composition root
are still outstanding.
