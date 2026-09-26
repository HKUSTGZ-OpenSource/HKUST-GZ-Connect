# Independent EasyConnect compatibility work

This directory is a native Rust path toward an EasyConnect-compatible engine
that does not build, download, link, or embed `zju-connect`. The legacy
protocol work was behavior-derived from authorized official binaries and
black-box tests. The modern protocol contract also uses a documented,
license-compatible review of `zju-connect` v1.1.1 as a reference, followed by
independent Rust implementation and official-client/live-gateway validation.
Triton is intentionally not used: it is a GPU-kernel language, not a systems
networking runtime.

The current deliverable observes public gateway metadata, validates authorized
official packages, implements authentication, and contains both the reviewed
legacy TCP state machine and an isolated native implementation of the active
modern TLS 1.1 transport. The modular runtime now includes bounded IPv4
framing, a userspace TCP/UDP stack, authenticated gateway DNS from
`rclist.csp`/`conf.csp`, a bounded reviewed deployment-profile fallback when
the gateway omits it, and one loopback SOCKS5 TCP/UDP frontend. DNS from either
source travels only through the userspace VPN; the HKUST(GZ) production profile
disables system fallback. A validated truncated UDP answer retries the same
campus resolver over length-prefixed DNS TCP through that same userspace stack;
it never selects a public or operating-system resolver as fallback.
The same port can optionally require local proxy credentials and
accept authenticated HTTP CONNECT plus bounded ordinary HTTP/WebSocket
forwarding for clients that cannot authenticate to a SOCKS5 proxy. An approved
end-to-end SOCKS5 run reached the dedicated campus
test endpoint, and the domain-selective PAC loaded the campus site in an
isolated Chrome profile. The maintained netstack fork prevents stale-handle
panics when a pending UDP receive is closed. The current live UDP target
returned no response without destabilizing the engine; sustained load,
multi-flow, sleep/resume, and reconnect canaries remain release gates.

Module responsibilities and change rules are defined in
[`ARCHITECTURE.md`](ARCHITECTURE.md).
Implementation status and real-environment evidence are tracked conservatively
in [`../ROADMAP.md`](../ROADMAP.md).
The offline resource-directory boundary is defined in
[`spec/RESOURCE_CATALOGUE_V1.md`](spec/RESOURCE_CATALOGUE_V1.md); it does not
claim production retrieval support.

## Safety boundary

- TLS verification is mandatory. There is no `--insecure` mode.
- Authentication responses are parsed in memory and discarded.
- Snapshots exclude TWFID, CSRF values, RSA keys, cookies, tokens, passwords,
  session identifiers, and raw response bodies.
- Download URLs retain only host/path metadata; query strings, fragments, and
  URL credentials are discarded.
- The public Windows installer is streamed through SHA-256 without being saved.
  The configured size ceiling prevents unbounded downloads.
- Official Sangfor binaries, raw packet captures, and decompiler projects go in
  ignored internal directories and must not be committed or redistributed.
- Live testing must use approved test accounts and an isolated lab.

## Commands

Install Rust with `rustup`, then explicitly build the native research tools:

```bash
cd independent
cargo build --locked --release --no-default-features --features compatibility-lab
cd ..
```

Collect a current sanitized snapshot:

```bash
independent/target/release/ec-watch collect \
  --config independent/config/hkustgz.json \
  --output independent/snapshots/live/current.json
```

Compare it with the reviewed baseline:

```bash
independent/target/release/ec-watch collect \
  --config independent/config/hkustgz.json \
  --output independent/snapshots/live/current.json \
  --compare independent/baselines/hkustgz-production.json \
  --diff-output independent/diffs/live/current.json \
  --fail-on-change
```

Exit codes are `0` for success/no detected change, `1` for collection or parse
failure, and `2` when `--fail-on-change` detects a compatibility change.

Run offline tests:

```bash
cd independent
cargo fmt --all -- --check
cargo clippy --locked --all-targets --no-default-features -- -D warnings
cargo test --locked --no-default-features
cargo clippy --locked --all-targets --no-default-features --features compatibility-lab -- -D warnings
cargo test --locked --no-default-features --features compatibility-lab
```

The five research commands require `compatibility-lab`; normal Engine/helper/public Gateway-probe
builds do not. Research builds must not be staged into an application release. This opt-in does not
authorize gateway access, credential use or vendor-package inspection.

Run the credentialed behavior probe on macOS without putting either credential
in process arguments or a repository file:

```bash
probe_account=$(awk -F'"' '/^username/{print $2; exit}' config.toml)
{
  printf '%s\n' "$probe_account"
  security find-generic-password \
    -s hkustgzconnect -a "$probe_account" -w
} | independent/target/release/ec-probe \
  --config independent/config/hkustgz.json \
  --credentials-stdin \
  --output independent/snapshots/live/auth-probe.json
unset probe_account
```

The probe performs discovery, password configuration, one password
authentication, structural inspection of configuration/resources, and logout.
The resource stage also runs the bounded offline catalogue parser, but emits
only aggregate counts and capability flags. It never serializes resource
labels, vendor identifiers, hosts, paths, queries, fragments, services, raw
authorization values, account identifiers, credentials, RSA/CSRF material,
cookies, session identifiers, or response values. This parser pass does not
enable authenticated catalogue retrieval in the production engine.

Add `--modern-tunnel-probe` only in an approved lab. It derives the in-memory
48-byte token, verifies the special TLS server identity, requests a virtual
address, establishes empty send and receive channels, closes all three, and
logs out. It sends no IP packet and serializes no token or assigned address.
The special service normally reuses the leaf certificate from the verified
HTTPS connection. If it presents a distinct privately managed certificate,
set `modern_tunnel.special_tls_leaf_sha256` only after an administrator verifies
the observed SHA-256 fingerprint through the gateway management plane.

Inspect an authorized official Linux package without extracting it into the
repository:

```bash
independent/target/release/ec-binary-watch \
  independent/artifacts/EasyConnect_x64_7_6_7_3.deb \
  --output independent/snapshots/live/linux-official-binary.json
```

The binary observer records package/binary SHA-256 values and named capability
booleans. It accepts uncompressed, gzip, xz, and zstd Debian tar members, so a
packaging-only vendor update does not disable inspection. It does not copy
arbitrary vendor strings or code into its output.

Map protocol behavior markers and text-relative references in an authorized
official executable:

```bash
independent/target/release/ec-protocol-map \
  independent/artifacts/easyconnect-linux-7.6.7.3/package/usr/share/sangfor/EasyConnect/resources/bin/svpnservice \
  --output independent/snapshots/live/linux-protocol-map.json
```

The protocol mapper emits hashes, marker counts, and `.text`-relative
references only. It supports x86 and x86_64 and never emits vendor code or
strings. The legacy handshake and `IPCP` frame behavior derived from the
reviewed map is documented in
`spec/PROTOCOL.md` and regression-tested with synthetic values.

Validate the version adapter against an authorized official executable:

```bash
independent/target/release/ec-adapter-check \
  independent/artifacts/easyconnect-linux-7.6.7.3/package/usr/share/sangfor/EasyConnect/resources/bin/svpnservice \
  --output independent/snapshots/live/linux-preface-adapter.json \
  --compare independent/baselines/easyconnect-linux-7.6.7.3-adapter.json \
  --diff-output independent/diffs/live/linux-preface-adapter.json \
  --fail-on-change
```

The adapter locates only call-referenced, structurally valid preface templates
in the local executable. It handles reviewed x86_64 fixed templates and the
reviewed x86 template whose 32-byte runtime region begins at offset 44. Raw
preface bytes and runtime material never enter Git or the JSON report. Unknown
architectures, ambiguous candidates, changed lengths, or malformed records
fail closed. A reviewed hash difference exits with status `2`. Reviewed Linux
and Windows L3 baselines are in `baselines/`.

An approved lab may add `--tunnel-handshake <official-executable>` to
`ec-probe`. This performs only a selected compatibility handshake and does not
send an `IPCP` business frame. A server reset, closed response, or unsupported
command is reported as incompatible; the probe still logs out and serializes
no session binding, address, cookie, or credential. This option is a diagnostic
gate, not a production tunnel.

The modern transport's TLS 1.1 + RSA + RC4-SHA contract is obsolete
cryptography forced by the gateway. It lives in one non-generic module,
requires certificate/hostname verification or an administrator-approved pin,
validates both Finished messages and every record MAC, and cannot be selected
as a general TLS implementation.

`ec-engine` is the maintained runtime. It accepts credentials only through
standard input, keeps the authenticated HTTPS session and address lease alive,
bridges EasyConnect IP packets into a userspace stack, resolves proxy domains
through gateway-supplied VPN DNS when present, or through an explicitly
enabled system resolver fallback, and exposes one loopback proxy frontend. DNS
uses UDP normally and same-server TCP only after a matching `TC=1` response. It
does not bind a second HTTP or DNS proxy port. It exits when the data plane
fails so its supervisor can reconnect the whole session. Local TCP connection
attempts are bounded so a dead destination cannot hold a proxy task forever.
Setup read timeouts do not expire an otherwise healthy idle receive channel.

Authentication ownership is separate from Modern L3 ownership.
`AuthenticatedGatewaySession` retains only the authenticated HTTPS cookie jar,
logout endpoint, and transport-neutral authenticated session identifier. It does not own parsed
L3 configuration, the Modern L3 token, DNS results, certificate pin, or data
plane. `ModernL3TransportBackend` performs configuration/token/bootstrap work,
and `ModernL3Connection` hands its DNS list and data plane to process assembly.
See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the complete ownership table.

## Local proxy frontend modes

The raw Engine keeps a flagless SOCKS5 `NO_AUTH` compatibility behavior and
stdin then contains exactly the gateway username and password lines. Shipped
Desktop new installations and the root macOS CLI pass strict authentication by
default. Passing either
`--socks-auth-optional-stdin` or `--socks-auth-stdin` changes stdin to exactly
four lines, in this order:

```text
gateway username
gateway password
local proxy username
local proxy password
```

The flags are mutually exclusive. The two local values are UTF-8, 1–255 bytes,
contain no control characters, and the username cannot contain `:`. They are
held in zeroizing memory and never appear in argv, engine events, or
diagnostics.

`--socks-auth-optional-stdin` is the compatibility-first desktop contract. It
accepts both SOCKS5 `NO_AUTH` and RFC 1929. If a client offers both, the engine
selects `NO_AUTH`, so existing Clash and SSH configurations remain unchanged;
an RFC-1929-only client must provide the configured credentials. HTTP-shaped
first packets remain disabled in this mode. UDP ASSOCIATE is available only on
a connection that negotiated `NO_AUTH`. If that connection selected RFC 1929,
UDP receives command-not-supported because SOCKS UDP datagrams contain no
credential capable of preventing another loopback user from adopting the
relay.

`--socks-auth-stdin` is the strict contract and selects only RFC 1929. On the
same loopback port it also accepts Basic-authenticated HTTP/1.0 or HTTP/1.1
proxy requests for Chromium-family clients that do not implement authenticated
SOCKS5. HTTPS and WSS retain `CONNECT`; absolute-form `http://` and `ws://`
requests use a separate bounded forwarder that rebuilds origin-form, emits one
authoritative `Host`, removes proxy and hop-by-hop headers, and never handles a
pipelined second request. Content-Length and validated chunked uploads stream
with fixed memory bounds; `100-continue` is handled locally, while ambiguous
framing and nonempty chunk trailers fail closed. WebSocket upgrades switch to
duplex streaming only after the authenticated, rewritten handshake. Missing
and incorrect HTTP credentials receive one fixed 407 response before method or
target validation. Strict mode always rejects SOCKS5 UDP ASSOCIATE.

## Engine lifecycle APIs

Engine Event API v1 remains the one-way, bounded engine-to-supervisor NDJSON
stream. It now finishes a normal or classified failure path with a structured
generation-bound `stopped` reason, so the desktop does not infer terminal state
from human diagnostics.

Control API v2 is a separate opt-in control plane. With
`--control-api-v2-stdin`, the engine reads the fixed two- or four-line
credential prefix and then keeps that already inherited private stdin pipe for
bounded control frames. Responses share bounded stdout NDJSON but use
`apiVersion: 2` and request IDs, while Event v1 remains unchanged. The Desktop
starts this secret-free handshake immediately after the credential prefix, and
the Engine answers before password authentication completes. The Desktop uses
the negotiated shutdown request later so the engine can close services
and log out, then retains bounded signal and force-stop fallbacks.

Control v2 opens no listener and its closed schema cannot represent a
credential, token, URL, or destination. EOF after a complete frame closes only
the optional control channel and never stops the tunnel; without the opt-in
flag, the previous credential read-to-EOF behavior is unchanged. Current
implemented capabilities are shutdown, request cancellation, and control
close. Resource, WebVPN, CAPTCHA, MFA, SSO, certificate, and HID names exist
only to return typed unsupported results; this is not feature support. See
[`spec/ENGINE_CONTROL_API_V2.md`](spec/ENGINE_CONTROL_API_V2.md) for framing,
bounds, negotiation, cancellation, and EOF semantics.

The generic interactive-auth framework is separate from v2. It provides an
Engine-owned transaction, a sanitized challenge view, bounded zeroizing
response bytes, and a secret-bearing Control API v3 codec for respond/resend/
cancel. v2 and v3 share one zeroizing inherited-pipe multiplexer. The shipped
password-only provider never creates or advertises an interactive transaction;
an unsolicited v3 command therefore returns only `transaction_closed`. The
non-shipped `ec-auth-fixture` and Desktop challenge coordinator exercise the
complete synthetic pipe until an authorized, sanitized Gateway protocol
fixture exists.

## Reproducible maintenance

`Cargo.lock` and `rust-toolchain.toml` are committed. CI therefore tests a
reviewed compiler/dependency graph instead of silently adopting new packages.
The `geiserx_ts_netstack_smoltcp` dependency is pinned to `0.43.0`; unlike the
abandoned `0.4.0` line, it generation-checks blocked UDP commands before
reusing a socket handle. This exact lifecycle bug is covered by the upstream
fork's tests and by the project's live close-then-TCP canary.
Dependency or compiler upgrades must pass the same fixtures, live public
metadata comparison, official-package comparison, provenance review, and
license review before merge.

Operational responses to repository deletion, vendor upgrades, certificate
rotation, cryptographic migration, and full protocol replacement are defined
in `UPGRADE_PLAYBOOK.md`.

## Directory policy

- `baselines/`: reviewed, sanitized metadata committed to Git.
- `config/`: public endpoint definitions only.
- `spec/`: behavior specifications and sanitized fixtures.
- `cleanroom/`: authorization, provenance, and evidence records.
- `artifacts/`: ignored official packages and extracted files.
- `captures/`: ignored raw traffic and process traces.
- `snapshots/live/`, `diffs/live/`: ignored CI/local results.
- `target/`: ignored native build output.

Updating a baseline requires a human review of the generated diff and evidence
that the official client and independent implementation pass the compatibility
test matrix. Never update a baseline merely to make CI green.

The module manifest's MD5 values are compatibility identifiers supplied by the
vendor, not a security trust decision. Artifact integrity monitoring uses
SHA-256, and release approval must separately verify the vendor signature.
