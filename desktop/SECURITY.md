# Desktop security model / 桌面端安全模型

This document records the security boundary of the Electron desktop client.
It is a maintenance contract, not a claim that arbitrary vendor or gateway
changes can be supported without review.

本文记录 Electron 桌面端必须长期维持的安全边界，供代码审核和网关升级时使用。
它不是“未来所有 EasyConnect 版本都无需维护”的承诺。

## Hard invariants / 不可破坏的约束

- The engine listener is always an explicit loopback endpoint. The app never
  changes system DNS, the default route, the global proxy, or a system network
  extension.
- 桌面新安装默认关闭严格认证以兼容 SOCKS5 客户端；回环地址不是跨本机用户/进程的
  授权边界。已有明确设置继续保留，共享电脑用户可手动开启严格认证。
- Desktop installations default to compatibility mode; strict authentication remains opt-in. A
  stable random local-proxy credential is encrypted with the operating-system
  secure-storage service; each engine generation receives only a short-lived
  in-memory copy. Campus Browser authenticates automatically, Clash receives an
  authenticated `udp: false` node through an explicit clipboard action, and
  the bundled SSH helper reads an owner-only sidecar that is removed whenever
  the listener stops. Credentials never enter argv or logs.
- Compatibility mode is an explicit downgrade for legacy SOCKS5 clients. It
  retains NO_AUTH and UDP ASSOCIATE behavior, so its local authorization risk
  must remain visible in the UI and documentation.
- The root macOS CLI also starts the Engine in strict mode. Its random local
  proxy credential is a three-line, owner-only sidecar shared only with the
  bundled Rust proxy helper; the VPN password remains in Keychain and neither
  secret enters argv or routine diagnostics. `proxy-config` is the sole
  explicit command that prints the local proxy credential for client setup.
- Campus Browser is one persistent, sandboxed, context-isolated Session. It
  denies device permissions, Node integration, arbitrary IPC, and unsupported
  navigation schemes.
- Before an engine releases its fixed local port, the browser closes a
  synchronous request gate, installs a fail-closed PAC, and drains connections.
  Only `listener_ready` for the current generation can reopen that gate.
- Engine Event API v1 is bounded one-way lifecycle/health output. Optional
  Control API v2 reuses the already inherited private stdin/stdout pipes after
  the fixed credential prefix; it opens no listener and its closed frame schema
  cannot carry arbitrary credentials, tokens, URLs, or destinations. Closing
  the control channel is not a tunnel-shutdown request. The secret-free v2
  handshake is answered during authentication, before L3/listener readiness.
- Interactive Auth Control v3 is a separate bounded, zeroizing, secret-bearing
  schema for sanitized challenge notification and respond/resend/cancel. Main
  owns its generation/transaction/epoch binding and sends Renderer only display
  metadata. Renderer clears the DOM response before IPC; Main and Rust clear
  bounded byte/frame copies after encoding, submit, cancel, expiry and teardown.
  JavaScript strings cannot be reliably overwritten in place, so the UI/Main
  code bounds them, drops references immediately and never attaches them to
  errors, logs, settings, telemetry or crash metadata; Rust owns the enforceable
  zeroizing secret boundary.
  The path is synthetic-only: the password-only provider creates no challenge
  and unsolicited v3 commands return `transaction_closed`.
- `EngineConnectionRuntime` owns stdout multiplexing, Event API generation
  validation, the hello deadline and pre-auth Control negotiation. `main.js`
  receives typed lifecycle callbacks and no longer parses Rust wire schemas.
- Routing-rule, certificate-pin and campus-resource IPC handlers are separate
  exact-key feature modules behind the trusted-sender registration boundary.
  They receive only injected stores/transactions; none can access Engine
  credentials, browser sessions or transport state.
- `SettingsCredentialIpc` owns the exact settings schema, policy-queue rebase,
  crash-safe credential journal invocation, recovery classification, logout
  mutation and best-effort clearing of every Main-process password reference.
  Main injects persistence and UI effects but no longer implements this flow.
- Control-panel routing, certificate and resource managers are separate
  sandboxed Renderer features loaded before `app.js`. They consume only their
  narrow Preload methods and escaped display models; connection/login/tower
  state remains in the small shell.
- `DesktopShell`, `CampusBrowserManager` and `ConnectionTelemetryCoordinator`
  separately own window/tray/quit policy, browser/vault construction, and
  Network health evidence. Main injects callbacks and contains no Chromium
  manager state, process-enumeration parser, SOCKS probe or telemetry timer.
- Public-egress observation is an explicit connection-page diagnostic. Main
  sends one credential-free HTTPS request per bounded local source address to
  a fixed external lookup service, using source-address binding and a hard
  deadline. Results remain in memory, expire quickly, and never enter settings,
  logs, telemetry or crash metadata. The UI must not infer proxy use or a
  specific physical/TUN path from this observation.
- Core control IPC validation is centralized beside settings/data IPC. CI also
  scans every Git-tracked text file for common private-key/cloud-token shapes;
  runtime-specific credential vocabulary remains covered by redaction/DTO tests.
- Chromium WebRTC is started with `disable_non_proxied_udp`. Explicit
  localhost, loopback, link-local, WebSocket, and legacy localhost aliases are
  denied again at `webRequest` because PAC mode cannot override Chromium's
  implicit loopback bypass.
- Certificate exceptions are exact HTTPS origin plus DER SHA-256 fingerprint,
  owner-only and local. Only an owned main-frame navigation can prompt; all
  subresource certificate errors fail closed. Prompts are globally
  single-flight and lifecycle cancellation rejects pending callbacks.
- Website credentials are exact HTTPS-origin scoped and encrypted by the OS.
  A traditional login may be offered only after a later successful main-frame
  navigation. A same-document SPA login may be offered only on the submitted
  HTTPS origin, before any main-frame commit, after every password form stays
  absent for a bounded settling interval. A remaining/reappearing password
  form cancels confirmation; password-change/reset forms are never captured.
  OTP/MFA/challenge fields and push-approval pages block autofill, capture and
  login-success confirmation. A committed challenge SPA can complete only
  after that exact origin and challenge state were observed.
  Both paths still require an explicit save confirmation. Linux `basic_text`
  fallback is rejected.

## Account and policy persistence / 账号与策略持久化

- The VPN username, encrypted password, settings, and settings backup use one
  owner-only rollback journal for every credential change and logout.
- Recovery runs before settings are loaded, credentials are inspected, or a
  journal permission could be changed. A missing journal is accepted only when
  absence is proven with `ENOENT`; transient I/O or permission errors block all
  connections and settings writes.
- A username change always requires a non-empty password in the same
  transaction. The non-decrypting password-presence probe is never treated as
  proof that no old credential exists.
- If a partial mutation loses its rollback journal, the encrypted password is
  durably removed; if removal cannot be proven, manual and automatic
  connections remain blocked.
- Domain rules, shortcuts, settings, external PAC, and the live browser policy
  are serialized. Policy updates suspend the browser first and roll every
  source/derived representation back on failure. Incomplete rollback leaves the
  browser blocked.
- Private JSON and credential files use bounded reads, regular-file/no-symlink
  checks, mode `0600` on POSIX, file `fsync`, same-directory rename, and
  directory `fsync`. Windows keeps the file-fsync/rename guarantee where
  directory handles are unavailable.

## Data that must never be emitted / 禁止输出的数据

Passwords, proxy credentials, cookies, tokens, raw authentication responses,
full resource URLs with queries, assigned addresses, and target addresses must
not enter engine stdout events, application logs, diagnostics, Git, CI
artifacts, or release notes. Engine stdout carries bounded Event API v1 NDJSON
and correlated bounded Control API v2 responses; neither schema contains a
secret field. Human diagnostics go to redacted stderr/log files with bounded
rotation, an 8 MiB cap on both the current and single rotated file, and a
persistent three-day retention window that is enforced even across app
restarts. Control v2 input frames begin only after the private stdin credential
prefix and have no arbitrary secret payload; the fact that both use one
inherited pipe does not make credentials part of Control v2.

The explicit **Copy Clash Node** action necessarily places the local proxy
credential on the operating-system clipboard, and Clash stores the pasted
credential in its own configuration. The application neither reads nor edits
that configuration. This user-authorized integration boundary is distinct from
logs, telemetry, renderer IPC responses, and process arguments, where the
credential remains prohibited. Interactive v3 response frames are the one
explicit authentication exception: they use only the inherited private pipe, bounded
zeroizing buffers and a schema that never emits the response back to events or
diagnostics.

## Known limits / 已知边界

- A PAC and URL-level request guard can deny explicit local-address literals,
  but cannot prove the resolved IP of every Direct hostname. Chromium's Private
  Network Access protections reduce DNS-rebinding risk; an absolute guarantee
  would require routing all browser traffic through a local policy proxy that
  resolves and validates destinations itself.
- Strict mode deliberately rejects SOCKS UDP ASSOCIATE. A TCP-authenticated
  control connection cannot securely establish cross-user ownership of a
  wildcard loopback UDP endpoint on every supported OS. Compatibility mode
  retains UDP for advanced clients.
- Any local process can consume pre-authentication TCP slots for the bounded
  handshake timeout. Cross-platform per-user ownership is unavailable for
  ordinary loopback TCP, so strict authentication protects authorization, not
  all same-host denial of service.
- The current production profile disables system-DNS fallback. The engine
  automatically reads authenticated DNS policy from `rclist.csp` and the
  optional `conf.csp` fields. Only when neither provides usable DNS does it use
  reviewed bundled profile addresses. The selected servers are bounded,
  deduplicated, destination-policy checked, and raced through the userspace VPN
  without changing the operating-system DNS configuration.
- Password, CAPTCHA, SMS/token/TOTP, certificate, HID, SSO, resource catalogue,
  WebVPN, and L3 are separate provider capabilities. An unimplemented or
  unknown method must surface as unsupported and fail closed, never be
  reclassified as a wrong password.

## Required review gates / 必须通过的门禁

Every release must pass desktop unit tests, syntax checks for every project JS
file, real Electron main/toolbar/layout
tests, SPA credential confirmation tests, true two-process route-restart
persistence, browser lifecycle/hidden-idle guards, dependency audit, Rust
format/Clippy/tests, offline performance matrices, package-content
verification, secret scanning, and unsigned macOS/Windows launch checks. Live
gateway TCP, UDP, DNS, sleep, network-change, forced-logout, and new
authentication canaries require explicit school authorization and sanitized
evidence.
