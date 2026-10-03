# Renderer browser-data settings owner

- Status: Current merged bounded M1 owner; not complete Renderer bootstrap or a released change
- Owner: Desktop Renderer maintainers
- Last verified: 2026-10-03
- Applies to: merged #214; verified development `main@eb5a60743427286e5af5c6eafce48d4ddaa5b63d`, not v2.0.3

The browser-data control has one native feature entrypoint mounted by the existing
feature host. Its classic HTML script and frozen `window.browserDataSettings`
exception retire together. The factory receives the bounded Preload API, document,
translation and campus-data display callback through injection. No new global,
IPC capability, persistence schema or clear policy is introduced.

Existing IDs, shared styles and bilingual keys remain unchanged. A first click
arms confirmation without clearing; the second submits the existing Main command.
Language changes disarm confirmation unless a clear is pending. Repeat clicks are
ignored while busy. Refusal, rejection and display-cleanup failures preserve the
existing failure feedback and newly confirmed retry behavior.

The owner starts once and terminal disposal removes both click and locale handlers,
attempting all removals even after failure. Retained callbacks and reset cannot
reactivate it. A submitted Main clear is not cancelled or undone; late completion
or rejection cannot repaint the retired DOM or call another presentation owner.
Main continues to own browser-session cleanup independently of Renderer lifetime.

Baseline native five-size shell checks precede movement and use a synthetic clear
counter, never installed application data. The native fixture verifies first-click
confirmation, language cancellation, confirmed completion and retained focus.
Unit tests cover busy state, disposal, late outcomes and cleanup failure; existing
behavior assertions are retained. Package requirements move from the retired
classic path to the native module. Native/ASAR and exact-head platform gates remain
separate from source checks and real-school acceptance.

One legacy global/script dependency is removed, from 25 to 24 frozen legacy files.
`app.js` grows four explicit composition lines; no file-size/dependency budget is
raised. This slice does not close M1's remaining bootstrap and HTML-order debt.

Rollback the feature, host/bootstrap/catalog, retired script, package requirement,
tests and this record together. No actual user-data clearing, application
replacement, Main/Engine protocol or system/third-party networking change.
