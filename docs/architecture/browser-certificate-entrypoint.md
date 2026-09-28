# Browser certificate consent entrypoint

- Status: Proposed bounded M5 contribution; not full dependency enforcement
- Owner: Desktop Browser and architecture maintainers
- Last verified: 2026-09-29
- Applies to: candidate based on development `main@f9a08adc`, not published v2.0.3

The existing `lib/browser/certificates/certificate-controller.js` becomes a file-level public
Browser entrypoint. It exports `CertificateController`, `certificateTime`, `routeCertificateError`
and the unchanged `CampusCertificateTrustStore` class; the module map does not enforce symbol-level
allowlists. Main uses dispatch and constructs that same store through this public boundary.
The trust-store implementation file, low-level pin persistence helpers and credential modules
remain private. The re-export does not create a second store or widen any pin/permission policy.

The existing dispatch and rejection functions move without changing their bodies from the private
`certificate-error-boundary.js` leaf, which is removed. Dispatch and user-consent coordination
belong to the same certificate domain, but remain separate functions/classes: Main supplies owned
WebContents/main-frame observations and the existing prompt callback; the controller owns bounded
consent, origin/fingerprint matching, single-flight prompts and lifecycle cancellation. Main does
not gain those algorithms. No trust-store format, TLS acceptance, global bypass, IPC, Session,
Preload or Renderer behavior changes.

Unowned WebContents keep Chromium's default handling. Only strict `owned === true` plus strict
`isMainFrame === true` can reach a supplied prompt; subresources and unknown frames are rejected
without a dialog. Missing/failing prompts reject the certificate. Event/callback teardown failures
cannot escape dispatch. A failed prompt never implies consent. The existing controller's exact
origin/fingerprint, single-flight and cancellation tests remain authoritative for its unchanged
implementation.

At this candidate Main falls to 895 lines, 30 direct and 44 effective dependencies; transitive
modules fall from 170 to 169. Production modules fall from 239 to 238. The entrypoint is 197 lines,
below the 600-line Browser-owner target. Both private Main certificate imports are resolved, so
the exact static-JS legacy edge inventory and hard cap fall from 115 to 113. No budget is raised.
Dynamic Renderer imports, Rust visibility and other legacy edges still prevent full M5 completion.

Unit/contracts cover dispatch, unknown ownership/frame values, missing or failing prompt effects,
unchanged consent/cancellation and the real Main/module-map import. Native Electron and exact
source/package gates must be recorded on the final candidate; source/offline coverage is not
live-school evidence. No real certificate, credentials, browser profile or installed data is used.

Rollback restores the former leaf, Main/test imports, controller exports and module-map/debt
ratchet as one change. There is no user-data migration, dependency upgrade, release or installed
application change.
