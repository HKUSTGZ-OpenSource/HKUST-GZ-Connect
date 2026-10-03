# Desktop trusted Control registrar

- Status: Proposed bounded M3/M5 assembly migration; not final Main composition or a release
- Owner: Desktop IPC maintainers
- Last verified: 2026-10-03
- Applies to: candidate based on `main@45d8685997b1268d5039685ee72ddf42843ad395`

The existing public Control IPC suite creates one Main-only registrar bound to
the injected `ipcMain`, current-WebContents getter and Control renderer file list.
The registration closure formerly in Main moves here and delegates to the same
`registerTrustedIpcHandlers`; sender/frame/file validation is not copied or changed.
Main constructs this registrar and passes it to the same fixed channel suites.

Construction registers nothing and does not resolve a window. Each handler
invocation looks up the current Control contents, so a missing window fails and
an old contents identity cannot borrow a replacement's handlers. Remote frames,
another local file and another sender retain the existing refusal. Original
handler arguments, returned values, asynchronous failure and void registration
return remain unchanged. Existing process-lifetime registration/disposal behavior
is preserved rather than replaced with a no-op lifecycle abstraction.

This is not a generic Renderer IPC bridge. Preload methods/channels, channel
schemas, domain handlers, credential access, Profile/Account/Workspace ownership
and the existing trust guard are unchanged. The registrar accepts Main-side
declarations only; the original channel/handler allow-pattern still applies.
Business rules stay in their domain services, not a new IPC application layer.

Three original IPC guard/handler tests pass on the base. Five new public-entrypoint
cases initially fail because the factory is absent, then pass. Together they
cover no construction effects, invalid declarations, exact forwarding, sender/
frame/file refusal, missing/replaced windows and retained asynchronous rejection.
Native Main integration and Renderer crash/recovery verify this wiring separately
from source/contract and Windows/macOS/Linux package acceptance.

Main falls 723 to 720 lines and 21 to 20 direct imports; production transitive
graph remains 170 and no node/dependency is added. One exact private Main import
retires, taking the inventory/cap 102 to 101. App-expanded effective imports fall
36 to 35; exact downward caps freeze Main at 720/20/35. Reaching the direct-import
target alone is not final 500–700-line composition or complete M5 enforcement.

Rollback the registrar/public binding, Main wiring, tests and downward ratchets
together. No persistent schema, secret projection, installed app, global/third-
party network, workflow/protection or release/tag change is included.
