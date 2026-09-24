# Architecture and module ownership

The maintained product is split at protocol and lifecycle boundaries. A vendor
change should normally require replacing one module and its fixtures, not
editing the SOCKS frontend, desktop UI, or unrelated protocol generations.

## Runtime path

| Module | Owns | Must not own |
| --- | --- | --- |
| `gateway_http.rs` | Origin-bound HTTPS client, internal cookie jar, bounded response and timeout policy | Probe workflows, transport, DNS, local proxy or UI |
| `gateway_auth.rs` | Redacted/zeroizing artifacts of completed Gateway authentication | Modern token, Data Plane, DNS or proxy policy |
| `credentials.rs` | Bounded two-line gateway credential stdin contract | Gateway HTTP, provider policy or protocol formats |
| `engine/provider.rs` | Stable AuthProvider/ResourceProvider/TransportBackend traits, capability states, typed unsupported/unavailable errors | Vendor wire formats, UI state, credentials at rest |
| `engine/provider_composition.rs` | Closed production protocol-family factory and one capability-bounded provider coordinator | Dynamic plugins, user-selected implementation names, vendor endpoint guessing or UI state |
| `engine/auth_transaction.rs` | Engine-owned generation/transaction/epoch/request binding, sanitized challenge view, zeroizing response, resend/cancel/abort invariants | Vendor endpoint, OTP shape, Renderer state or Data Plane |
| `engine/auth_control.rs` | Bounded zeroizing secret-bearing Control API v3 codec/session for synthetic/future interactive providers | Public listener, vendor endpoint or password-only capability claims |
| `engine/control_mux.rs` | Ordered v2/v3 decoding on the inherited private pipe; generic secret-free framing errors | Provider state, public listener or cross-schema coercion |
| `resource_catalogue.rs` | Bounded offline resource/group parser, opaque handles, redacted presentation schema and private launch-target resolution | Authenticated retrieval, authorization decisions, desktop rendering |
| `engine/session.rs::AuthenticatedGatewaySession` | Authenticated HTTPS cookie jar, logout endpoint and opaque gateway session identifier | Parsed L3 configuration, Modern L3 token, DNS servers, certificate pin, data plane or proxy policy |
| `engine/session.rs::{ModernL3TransportBackend, ModernL3Connection}` | Modern L3 configuration/token bootstrap, DNS handoff, certificate binding, data-plane assembly and cleanup on setup failure | Credentials at rest, desktop lifecycle or local proxy policy |
| `engine/control.rs` | Bounded secret-free Control API v2 frames, negotiation, request IDs, typed actions and unsupported-capability responses | Public listeners, credential parsing, lifecycle events, arbitrary payloads or direct process termination |
| `engine/event.rs` | Bounded Event API v1 lifecycle/health output and serialization of correlated Control v2 responses on the machine stream | Control request parsing or human diagnostics |
| `modern.rs` | Active token, 64-byte channel-control contract, gateway endpoint resolution and socket setup | HTTP UI, DNS, or SOCKS |
| `special_tls11.rs` | Isolated vendor TLS record/handshake compatibility | General-purpose TLS or authentication |
| `engine/data_plane.rs` | Address lease and send/receive channel ownership | TCP/UDP socket semantics |
| `engine/ip_packet.rs` | Bounded IPv4 validation and stream framing | Gateway authentication |
| `engine/netstack.rs` | Userspace TCP/UDP stack, packet bridges, bounded TCP connect | Proxy parsing or DNS wire parsing |
| `engine/dns.rs` | Bounded DNS A queries through VPN UDP, same-resolver TCP retry after a valid truncated response, and a TTL-bounded answer cache | Public/system DNS fallback |
| `engine/proxy.rs` | Shared destination validation plus gateway/system resolver policy | Listener lifecycle or gateway protocol |
| `engine/socks_auth.rs` | Bounded stdin proxy credentials, zeroizing constant-time RFC 1929/Basic verification | argv, events, logging, or gateway authentication |
| `engine/socks.rs` | One-port protocol detection and dispatch; compatible, optional-auth, and strict SOCKS5 contracts plus the strict HTTP frontend | HTTP message rewriting or gateway protocol details |
| `engine/socks/http_forward.rs` | Strict-only bounded ordinary HTTP/WS parsing, header rewriting, body framing, and streaming | DNS, destination authorization, credentials, or gateway protocol details |
| `bin/ec-engine.rs` | Process assembly, signals, health shutdown, Control v2 action integration, logout and structured terminal state | Event/control encoding or desktop policy |
| `desktop/lib/campus-browser.js` | Isolated browser session, proxy policy and safe navigation | Gateway authentication or packet formats |
| `desktop/lib/engine-connection-runtime.js` | Event/control stdout ownership, generation validation, hello deadline and typed Desktop callbacks | UI wording, credential persistence, Browser routing or Engine process policy |
| `desktop/lib/{routing-rule,certificate-pin,campus-resource}-ipc.js` | Exact-key control-panel CRUD validation and injected transaction calls | Electron window ownership, authentication or transport state |
| `desktop/lib/settings-credential-ipc.js` | Exact settings IPC, policy rebase, credential journal/recovery and logout orchestration | Electron window/tray rendering, Engine protocol or password decryption |
| `desktop/lib/desktop-shell.js` | Control window, tray/menu, close prompt and ordered quit cleanup | Engine protocol, Browser routing, settings format or credentials |
| `desktop/lib/campus-browser-manager.js` | Browser/Vault construction, route/open result mapping and browser lifecycle delegation | Engine process ownership, Gateway protocol or system network changes |
| `desktop/lib/connection-telemetry-coordinator.js` | Process enumeration, latency/health evidence and bounded reconnect trigger | Authentication, UI DOM or packet forwarding |
| `desktop/lib/core-control-ipc.js` | Exact core channel schema and narrow operation delegation | Electron/Engine implementation details or secret storage |
| `desktop/renderer/{routing,certificate,resource}-manager.js` | Escaped feature-local DOM state and narrow Preload CRUD calls | Rust schema, Main persistence, credentials or connection lifecycle |
| `desktop/lib/tunnel-health.js` | When to probe the tunnel and how much evidence a restart requires | Probing itself, or engine lifecycle |

The loopback listener is the current shared frontend, not a permanent product
constraint. The raw Engine retains a flagless SOCKS5 `NO_AUTH` compatibility
contract. Desktop new installations use optional authentication for compatibility,
while the independent root macOS CLI passes the strict-auth flag by default. The explicit optional
contract accepts both `NO_AUTH` and RFC 1929, preferring `NO_AUTH` when both are
offered so legacy tools stay compatible. Its UDP decision follows the selected
method: `NO_AUTH` retains UDP while RFC 1929 rejects it. The separate strict
contract requires RFC 1929 for SOCKS5 and exposes Basic-authenticated HTTP
CONNECT on the same port because Chromium does not support authenticated
SOCKS5. It also accepts authenticated absolute-form `http://` and `ws://`
requests through a
separate one-request forwarder. That forwarder rebuilds origin-form and `Host`,
strips proxy and hop-by-hop headers (including fields named by `Connection`),
bounds headers, bodies, chunks, framing lines and idle response writes, and
never parses a pipelined second request. HTTPS/WSS continue to use CONNECT.
Default and optional modes do not expose any HTTP proxy. Strict mode also
rejects UDP ASSOCIATE: RFC 1929 authenticates only its
TCP control stream, and first-datagram endpoint learning on a shared loopback
address would let another local user adopt the relay. Additional
per-application or managed system frontends may be added behind the same
destination policy. They must not modify system DNS or routes by default.

## Authentication, transport and lifecycle boundaries

`AuthenticatedGatewaySession` is deliberately authentication-only. It keeps
the verified HTTPS session needed for authenticated requests and logout plus
the transport-neutral `AuthenticatedSessionId` returned by login. It does not retain a
parsed L3 configuration, the Modern L3 transport token, DNS results, a tunnel
certificate pin, or an `EasyConnectDataPlane`. `ModernL3TransportBackend`
obtains those transport inputs, and `ModernL3Connection` hands the resulting
DNS list and data plane to process assembly. A failed transport setup logs out
the still-valid authenticated session instead of leaving ownership ambiguous.

Authentication and Transport setup run in process-owned blocking workers while
the async coordinator continues consuming private control, EOF, signal and
deadline events. Cancellation is cooperative between bounded network calls.
A cooperative late result is drained and cleaned; if an in-flight synchronous
syscall does not return within the cancellation drain deadline, the Engine
terminates with cleanup-unconfirmed. It never promotes that late result or
waits past the Desktop graceful-stop envelope.

Normal runtime shutdown is ordered and bounded: process assembly first closes
and drains the local proxy service, then `VirtualNetstack::shutdown` closes all
three Modern data-plane sockets, aborts/awaits the Tokio runner, and joins both
packet bridge threads before Gateway logout begins. `VirtualNetstack::Drop`
performs only non-blocking socket closure and runner cancellation as a panic/
early-return backstop; it is not evidence of a successful normal join. A join
that exceeds the runtime deadline is a typed `DATA_PLANE_SHUTDOWN_FAILED`
terminal failure rather than a clean user stop.

The non-default `engine-lifecycle-fixture` Cargo feature exercises this same
post-Transport process assembly through a bounded repeated soak of real
`ec-engine` subprocesses using a non-routing packet transport and disabled DNS.
It carries a fixed packaging
tripwire: `afterPack` rejects it before signing and the standalone verifier
checks it again after packaging. It is evidence for netstack/listener/control/
shutdown/port ownership only; it is not evidence for Gateway authentication,
Modern L3, vendor wire, Gateway logout, or campus traffic. Production and
release builds explicitly use `--no-default-features`.

The local engine APIs also have separate directions:

- **Engine Event API v1** is a one-way engine-to-supervisor bounded NDJSON
  stream. It carries lifecycle and health facts. A terminal sequence emits
  `state_changed: stopped` followed by `stopped` with a typed reason and the
  engine generation, allowing the desktop to reject stale-process output.
- **Engine Control API v2** is an opt-in, bidirectional control plane over the
  already inherited private stdin/stdout pipes. Requests use a closed schema,
  a 2048-byte frame limit, version negotiation and request IDs. It opens no
  listener and cannot represent credentials, tokens, URLs or destinations.
  Its handshake is answered during authentication, before L3/listener setup.
  Its currently advertised capabilities are shutdown, cancellation,
  control-channel close and the additive secret-free provider-capability query.
  That query is bound to the reviewed Profile revision and Engine generation;
  Event API v1 remains unchanged. The process assembler applies accepted actions;
  `engine/control.rs` itself never terminates a process.
- **Interactive Auth Control API v3** is a separate, secret-bearing bounded
  schema over the same inherited private pipe. It supports sanitized challenge
  notification plus respond/resend/cancel with zeroizing inputs. The process
  assembler multiplexes the schema but the current password-only provider
  creates no transaction or challenge; unsolicited v3 commands fail closed as
  `transaction_closed`. A non-shipped synthetic Engine and the Desktop
  coordinator exercise the interactive path without claiming Gateway support.

The complete wire and EOF contract is in
[`spec/ENGINE_CONTROL_API_V2.md`](spec/ENGINE_CONTROL_API_V2.md). Recognizing a
provider capability name in that closed schema is not production support:
resource retrieval, WebVPN and MFA remain typed unsupported until their own
providers and school-environment evidence exist.

The provider-inactive interactive-auth schema and activation gates are documented in
[`spec/ENGINE_AUTH_CONTROL_API_V3.md`](spec/ENGINE_AUTH_CONTROL_API_V3.md).

## Compatibility laboratory

| Module | Purpose |
| --- | --- |
| `watch.rs` | Public gateway metadata snapshots and diffs |
| `binary_watch.rs` | Bounded official-package identity/capability observer |
| `protocol_map.rs` | Architecture-aware marker and reference mapping |
| `adapter.rs` | Version-specific legacy preface extraction and validation |
| `probe.rs` | Authorized, redacted behavioral probes |
| `config.rs` | Gateway/resource configuration parsers |
| `tunnel.rs` | Legacy state machine retained as a compatibility backend |

Compatibility observers never sit in the production packet path. Raw official
binaries, captures, live snapshots, credentials, tokens, cookies, and assigned
addresses are excluded from Git.

## Change rules

1. Detect a change with the public watcher before changing runtime code.
2. Reproduce it with an authorized official client and sanitized fixture.
3. Update the narrowest adapter or protocol backend.
4. Add a bounded offline regression fixture.
5. Pass formatting, lint, unit tests, observer comparisons, restricted
   authentication/channel canaries and approved SOCKS TCP, domain, and UDP
   canaries.
6. Keep the preceding backend until the new EasyConnect release is validated,
   then select by an explicit observed version contract.

No UI file may encode gateway packet formats. No protocol module may read a
password from disk or command-line arguments. No compatibility failure may
silently fall back to disabled certificate validation.

Provider capability semantics and the evidence gate for new adapters are
specified in [`spec/PROVIDER_CONTRACTS.md`](spec/PROVIDER_CONTRACTS.md). The
current model marks only password authentication and L3 transport supported;
MFA families, WebVPN, unknown secondary authentication, authenticated resource
retrieval, and resource authorization decisions fail explicitly until their
own reviewed providers exist. `OfflineResourceDocumentProvider` is a parser
harness, not a production retrieval adapter.

## Latency contract

Every tunneled IPv4 packet becomes exactly one record on the gateway transport,
so a per-write delay is a per-packet delay. Three rules keep an interactive page
load from degrading into seconds of stalls, and each has a regression test:

1. A record reaches the socket in **one** write. Emitting the header separately
   creates a small segment followed by a dependent read, which Nagle plus the
   peer's delayed ACK turns into a stall of tens of milliseconds per packet.
2. Every socket in the path sets `TCP_NODELAY` — the gateway connections and the
   accepted loopback SOCKS clients.
3. Proxy name resolution is cached with a bounded TTL **and** collapsed per host
   while a query is in flight. A SOCKS5 client that resolves through the proxy
   sends the hostname on every CONNECT, so an uncached resolver multiplies one
   round trip by the number of connections a page opens — and a cache alone does
   not help the first visit, because a browser opens those connections at once.
   The in-flight leader must free its slot even when its task is dropped, or a
   cancelled lookup strands every waiter.

The userspace `smoltcp` sockets still run with Nagle enabled. The netstack fork
creates them in `socket_impl/tcp/mod.rs::new_tcp_socket` and applies only
`tcp_keep_alive_interval` and `tcp_timeout` from its `Config`, so there is no
local hook for it; adding a `tcp_nagle_enabled` field there is the upstream fix.
That path matters less than the gateway transport: its writes come from
`copy_bidirectional` and are usually a full segment already.

## Reachability contract: advertised MTU

Some campus destinations cannot be reached at all with a full-size MTU, and the
failure does not look like a network error. Observed against
`eform.hkust-gz.edu.cn` through a working tunnel:

| probe | result |
| --- | --- |
| TCP CONNECT to :443 | succeeds in 33ms |
| invalid TLS record to :443 | server replies with a 7-byte alert in 419ms |
| real TLS handshake to :443 | never completes, 3/3 attempts |
| HTTP on :80 | 301 in 77ms, including an 8 KB POST body |
| `www.hkust-gz.edu.cn` :443 | 111 KB downloaded in 1.14s |

The host is reachable and responsive; only its multi-kilobyte reply disappears.
That is a path-MTU black hole: the destination is told it may send 1460-byte
segments, the oversized packets are dropped somewhere inside the campus network,
and the ICMP notification that would let TCP discover this never arrives, so the
connection retransmits until it times out.

Confirmed by rebuilding with an advertised MTU of 1400: the same request that had
returned nothing after 40s returned `302` in 0.11s, three times out of three, and
the other campus hosts were unaffected.

`DEFAULT_STACK_MTU` is therefore below `MAX_TUNNEL_PACKET_BYTES` on purpose:

* the advertised MTU sets the segment size campus servers use, so lowering it is
  what makes these hosts reachable;
* the framing limit stays at 1500 so a full-size packet from the gateway is still
  accepted — rejecting one propagates an error that stops the receive bridge and
  takes the whole tunnel down.

Tune with `tunnel.mtu` in the engine configuration, or `HKUSTGZ_TUNNEL_MTU` for an
installed build whose bundle signature must not be disturbed. The engine prints
the value it settled on at startup.

## VPN DNS source selection

`engine/dns.rs` owns the bounded DNS client that sends UDP through
`VirtualNetstack` and retries a valid matching `TC=1` response over length-prefixed
TCP to the same resolver through the same netstack. It does not modify
operating-system DNS or routes. The runtime selects one of two reviewed sources:

1. addresses authenticated and advertised by the gateway in
   `rclist.csp` (`Resource/Dns@dnsserver`) or the optional `conf.csp` L3 fields;
2. `proxy.vpn_dns_servers` from the deployment profile, used only when neither
   authenticated response provides usable DNS.

The selected list is deduplicated, capped at eight servers, checked by the same
tunnel destination policy as SOCKS TCP/UDP, and raced to the first valid A
answer. UDP timeout or failure does not cause a public/system query or speculative
TCP hedge. The HKUST(GZ) production profile supplies `10.90.63.2` and
`10.90.63.3` and sets `proxy.allow_system_dns_fallback` to `false`. This keeps
HPC-only hostnames inside the VPN while still adopting new gateway-advertised
DNS automatically. The Event API reports `gateway` or `vpn_profile` without
exposing server addresses; the older `gateway_profile` value remains accepted
for protocol compatibility but is no longer produced by source selection.

The system resolver implementation remains available only for a separately
reviewed deployment profile that explicitly enables it. It is not selected by
the HKUST(GZ) production configuration.
