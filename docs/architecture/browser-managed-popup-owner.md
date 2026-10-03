# Managed credential popup lifecycle owner

- Status: Proposed bounded M2 extraction; not full Browser lifecycle ownership
- Owner: Desktop Browser maintainers
- Last verified: 2026-09-29
- Applies to: candidate based on development `main@8a9e74ffcfd8d67c14b43fc4d4fc5c90edbecda8`, not published v2.0.3

`ManagedCredentialPopupOwner` now owns the native authentication child window, its hardened
WebPreferences, navigation/event listeners and idempotent retirement. It is a separate class
co-located with the existing `CredentialController` to preserve the reviewed Main transitive
dependency cap. The Browser orchestrator injects its active parent window, Campus Session,
preload, safe URL gate and narrow navigation/diagnostic callbacks. It keeps forwarding methods
for existing Browser callers and a read-only compatibility reference to the owner's popup set.

The child remains a native window, not a tab: Session cookies, `window.opener`, postMessage and
page-driven self-close keep their existing Electron semantics. The owner links only opaque
credential-flow ownership; it does not copy password, OTP or challenge values into the popup.
The untrusted page cannot select its own Session, preload, Node integration, sandbox or web
security setting. Unsupported schemes are denied before creation and on child redirects.
Renderer crash, native close and Browser-window teardown all retire the popup once; an absent
parent/Session or failed Session lookup releases the reservation and fails closed. A queued
ordinary-popup callback is dropped if its parent window or active Profile context retires before
the callback runs; a reserved MFA child cannot be created after context retirement.

The Browser orchestrator falls from 1,333 to 1,236 lines. The co-located credential module is
492 lines, below the existing 600-line owner ceiling; Main's transitive dependency count remains
170. Routing, login-success judgment, credential persistence and the Engine remain unchanged.
M2 is not complete: other Browser event/routing lifecycle work still resides in the root.

Synthetic tests cover native options, Session identity, scheme denial, ordinary-popup delegation,
stale callbacks, crash/close idempotence, failed Session lookup and failed flow linking. Existing
Browser, popup MFA, strict-proxy, performance/soak, exact-tree secret and package checks must pass
before merge. These checks do not establish live school login success or installed application
behavior.

Rollback the popup owner, Browser wiring, tests and this record as one change. No IPC wire,
persisted schema, user data or published artifact is modified.
