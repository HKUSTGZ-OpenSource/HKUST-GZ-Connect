# Browser application request-security boundary

- Status: Proposed bounded M3 extraction; not a release or full Browser/Main composition
- Owner: Desktop Browser maintainers
- Last verified: 2026-10-03
- Applies to: candidate based on development `main@d553493719860853c680d72a2c6f05f32ab19f73`

`BrowserRequestSecurityBoundary` co-locates the existing application-event dispatch
with the Browser certificate consent entrypoint. The public Browser Manager factory
constructs it and the original certificate-trust store. Main keeps the application
event registration; it no longer implements their ownership/security decisions.

Certificate dispatch delegates the unchanged `routeCertificateError` policy:
unowned Control/toolbar/other requests keep Chromium default handling; owned
subresources and unknown-frame errors reject without a dialog; only owned main
frames reach the existing explicit-consent controller. Failed consent still calls
the existing fail-closed path. Store identity, origin/pin persistence, prompt
single-flight and cancellation are unchanged.

Proxy dispatch captures one current Engine generation, checks Browser ownership
before asking the existing proxy access owner to match the exact challenge, then
passes that same generation/callback back to the credential owner. Control chrome
and unrelated WebContents cannot borrow proxy credentials. No challenge checks,
secrets, pin parsing or proxy mode are duplicated in this boundary.

The boundary holds only injected capabilities and bound handlers; it owns no
Session, timers, promise registry, listener subscription or credential lifetime.
Application listeners remain registered by Main for the process lifetime. Each
event resolves the current Browser; there is no stale construction snapshot. The
Browser, certificate controller and proxy credential owners retain teardown.

Nine public-seam cases initially fail because the factory is absent, then pass:
effect-free construction, ownership/frame gates, exact forwarding, prompt failure,
unowned/nonmatching proxy challenges, captured generation, current Browser and
unchanged trust-store type/deferred file access. The existing consent and module
contracts remain. The isolated Electron strict-proxy fixture now directly registers
this production dispatch handler for Chromium's real HTTP/WS challenge path,
rather than keeping a duplicate fixture-only policy. MFA/Profile/Engine and
exact-source/platform checks are separate requirements, not real Gateway evidence.

Main falls from 800 to 776 lines and 27 to 26 direct dependencies with no new
production file or transitive dependency. Static private-edge debt remains 110;
removing one already-public import is not represented as eliminating another debt
exception. M3 is incomplete because the intermediate dependency target is 24 and
the final composition target is still stricter.

Rollback the Manager factory, boundary, Main wiring, test-seam update and this
record together. No IPC/schema/migration, user data, global networking, installed
application or release change.
