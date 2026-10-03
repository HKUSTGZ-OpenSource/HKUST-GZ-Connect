# Control Tower form ownership in Renderer

- Status: Proposed bounded M1 extraction; not full Renderer bootstrap convergence
- Owner: Desktop Renderer maintainers
- Last verified: 2026-09-29
- Applies to: candidate based on development `main@5e43eb4`, not published v2.0.3

`renderer/features/control-tower/index.mjs` is the explicit public entrypoint for the advanced
settings form. The existing feature host mounts it with the bounded Preload API, document,
translation, current settings accessor, settings writer, state refresh, proxy-auth migration owner
callback and timer effects. It owns form projection, unsaved-edit preservation, port/retry validation,
explicit Apply, saved/reconnect-warning feedback, SOCKS endpoint copy, listener cleanup and retired
timer/async-result fencing. It does not load files, open sockets, read Engine output or expose a
new `window.*` symbol. The existing `renderer/app.js` still composes it and keeps page navigation,
connection intent and account lifecycle authority.

The pre-existing proxy-auth migration stays in its separate legacy owner: its one-purpose immediate
security decision still uses its own narrow `api.save({ strictProxyAuth })` or acknowledgment call.
The form owner and migration communicate only through injected `isSaving`, `isBusy`, `render` and
`flash` callbacks; ordinary checkbox edits do not become immediate saves. A failed reconnect remains
visible as a warning, not as a successful connection claim. The save patch still contains exactly
the previous six settings. There is no IPC payload, schema, credential, Browser Session, Rust Engine,
network route or release change.

The candidate reduces the Renderer bootstrap from 502 to 405 lines, without increasing its 562-line
architecture cap or Main's dependency/fan budgets. HTML and CSS are unchanged, so the existing
Control Tower feature root continues to scope visual rules. The static registry has one explicit
new owner and host dependency; it rejects undeclared imports and new global exports. Other classic
HTML-order and global-script debts remain, so M1 stays open.

Synthetic owner tests cover dirty-form preservation, exact patch/validation, migration contention,
reconnect warning, SOCKS-only copy, timer/listener retirement and pending-save disposal. Existing
strict-proxy contracts, narrow/standard/wide native layout, keyboard/focus/overflow/reduced-motion,
full Desktop and exact package/security gates must be recorded separately on the final candidate.
These offline checks do not prove a real Gateway reconnect or user-account behavior.

Rollback the owner, bootstrap wiring, registry, tests and this record together. Persisted user data,
installed applications and published tags are untouched.
