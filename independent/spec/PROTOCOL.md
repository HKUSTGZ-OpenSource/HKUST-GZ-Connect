# EasyConnect compatibility specification

Status: authentication/configuration behavior and the active modern TLS
send/receive family are implemented for the current production profile. The
native data path has carried live IPv4/TCP traffic through SOCKS5, and an
isolated Chrome PAC canary loaded the campus site. The legacy TCP L3 family is
retained only as a versioned compatibility backend because this gateway
rejects its command path. Live UDP reachability and authentication methods not
enabled by this profile remain separate release gates.

## Current observed production profile

- Gateway family: Sangfor SSL VPN
- Reported gateway version: `M7.6.8R2`
- Initial authentication: username/password (`StartAuth=1`)
- Graphical challenge: disabled (`RndImg=0`)
- Multiple concurrent clients: disabled
- Device type: `ssl`
- Windows client manifest: `/com/WindowsModule.xml`
- macOS/Linux package metadata: `/por/ec_pkg.csp`

## Functional layers

The independent implementation separates these layers:

1. Discovery: gateway version, capabilities, authentication entry point.
2. Authentication: password, CAPTCHA, SMS, TOTP, certificate, HID, SSO.
3. Session: TWFID/cookie lifecycle, logout, keep-alive, reconnect.
4. Configuration: parse `conf.csp` without retaining credentials.
5. Resources: parse `rclist.csp`, routes, domains, DNS, and resource policy.
6. Tunnel transport: handshake, framing, sequencing, liveness, and errors.
7. Local exposure: one loopback listener plus desktop PAC; SOCKS5 TCP/UDP by
   default, a compatibility-first optional-auth contract that accepts
   `NO_AUTH` or RFC 1929, and a strict RFC 1929 contract with authenticated HTTP
   CONNECT on that same port; strict mode also has a bounded authenticated
   absolute-form HTTP/WS forwarder, while default and optional modes reject
   HTTP; optional TUN later.

## Known public endpoint families

```text
/por/login_auth.csp
/por/login_psw.csp
/por/rand_code.csp
/por/login_sms.csp
/por/login_sms1.csp
/por/login_sms2.csp
/por/login_token.csp
/por/login_cert.csp
/por/login_hid.csp
/por/conf.csp
/por/rclist.csp
/por/update_session.csp
/por/logout.csp
```

Endpoint names are compatibility evidence, not a guarantee of stable behavior.
Every request/response contract must be backed by sanitized fixtures and an
official-client black-box test before it is marked implemented.

## Authentication state model

```text
DISCOVER
  -> PRIMARY_PASSWORD
  -> optional CAPTCHA
  -> optional SMS | TOTP | CERTIFICATE | HID | SSO
  -> SESSION_AUTHENTICATED
  -> CONFIGURATION
  -> TUNNEL_READY
```

No UI or engine component may assume that successful password submission means
the session is authenticated. Unknown next-authentication values must result in
a structured `auth_required` or `gateway_incompatible` event, never an
unbounded retry.

## Password authentication contract

Evidence: bundled official macOS client `7.6.7.10` static behavior plus one
approved black-box run against the production profile. This is a behavior
description, not copied implementation source.

1. Keep one TLS-verified cookie jar for the complete exchange.
2. Request `GET /por/login_auth.csp?apiversion=1`.
3. Request `GET /public/psw_config?apiversion=1`.
4. Read the RSA modulus, decimal exponent, and anti-replay challenge from the
   password-configuration response. These values are transient secrets and
   must never be logged or serialized.
5. UTF-8 encode `password + "_" + anti_replay_challenge`.
6. Encrypt it with RSAES-PKCS1-v1_5 and emit fixed-width lowercase hexadecimal.
7. Form-POST to
   `/por/login_psw.csp?anti_replay=1&encrypt=1&apiversion=1` with:

```text
mitm_result=
svpn_req_randcode=<anti-replay challenge>
svpn_name=<account>
svpn_password=<RSA ciphertext hex>
svpn_rand_code=<CAPTCHA response or empty>
```

8. `ErrorCode=1` is authenticated for the observed profile. A non-empty
   `NextService` transitions to the corresponding secondary-authentication
   state instead of being treated as tunnel-ready. Until a reviewed provider
   implements that state, production performs a bounded best-effort logout and
   returns the stable `UNSUPPORTED_AUTHENTICATION` machine code.
   A valid `PasswordRequired` transition is the only current response mapped
   to `AUTH_REJECTED`. HTTP timeout/reset/partial-read outcomes map to
   `AUTH_INDETERMINATE` after the password POST; Gateway availability failures
   before the POST map to `GATEWAY_PRELOGIN_UNAVAILABLE` and may use the bounded
   connection retry budget. Malformed or unknown structured results map to
   `AUTH_PROTOCOL_INVALID`. Cleanup failure is reported as secondary
   `AUTH_CLEANUP_UNCONFIRMED` and never overwrites the primary outcome.
9. After authentication, the observed profile returned XML from
   `/por/conf.csp?apiversion=1` and `/por/rclist.csp?apiversion=1`.
10. Logout is `GET /por/logout.csp?apiversion=1`.

VPN DNS remains independent of authentication protocol details. Queries use
the authenticated gateway DNS list, or the reviewed deployment-profile list
only when the gateway supplies none. A normal query uses UDP through
`VirtualNetstack`; only a successful response with matching transaction ID and
question plus `TC=1` opens length-prefixed TCP to that same resolver on port 53.
UDP and TCP share one timeout. Failure never falls back to a public or system
resolver in the HKUST(GZ) production profile.

The observed password key was 2048 bits and the anti-MITM helper flag was off.
Those are profile facts, not hard-coded requirements. Redirects and TLS
downgrades fail closed in the probe.

## Required structured engine events

```json
{"event":"auth_required","method":"captcha","challenge_id":"opaque"}
{"event":"connected","client_ip":"redacted-in-test-fixtures"}
{"event":"disconnected","reason":"gateway|network|user|incompatible"}
{"event":"gateway_incompatible","stage":"auth|config|tunnel","code":"opaque"}
```

## Evidence still required

- Exact password encryption behavior across gateway revisions.
- Secondary-authentication transition matrix.
- Certificate and HID behavior under approved lab accounts.
- Additional `conf.csp` and `rclist.csp` variants from future gateway families.
- L3 tunnel ClientHello, token derivation, framing, and keep-alive behavior.
- Live SOCKS5 UDP parity, gateway UDP reachability, and sustained datagram
  behavior. The local frontend implements RFC 1928 UDP ASSOCIATE for IPv4 and
  domain destinations, rejects fragmented SOCKS datagrams, and binds one
  loopback client endpoint per control connection in the explicit `NO_AUTH`
  compatibility mode. Optional authentication retains UDP only when that
  connection selected `NO_AUTH`; its RFC 1929 branch and strict RFC 1929 mode
  reject UDP ASSOCIATE because the datagrams carry no credentials and loopback
  source IP cannot identify a local user. Learning the first datagram after an
  authenticated exchange would permit cross-user relay theft.
- aTrust detection and protocol handoff.

Raw evidence for these questions belongs in the restricted lab, while only
sanitized behavior specifications and synthetic fixtures belong in Git.

## Configuration/resource parser observations

The production profile passed the legacy Rust transport and resource
field/port parsers in an approved credentialed run. The v1 directory parser
below has not yet had an authorized live canary. Resource port policies use
both hyphen (`80-90`) and tilde (`80~90`) range separators; empty, `0`, and `*`
mean unrestricted. Sets may use commas, semicolons, pipes, or whitespace.
Bounds outside `1..65535`, reversed ranges, and unknown syntax fail closed.

The maintained resource parser additionally enforces document, element,
nesting, group, resource, identifier, label, target, service and authorization
limits. It rejects duplicate identifiers, unresolved group/default references,
URL user information, unsupported URL schemes and ambiguous bare targets. The
versioned presentation view contains opaque handles, labels, grouping, type,
protocol, aggregate port policy and target shape, but never a vendor identifier,
host, path, query, fragment, service value or raw authorization value. Exact
launch material remains behind a non-serializable handle and has redacted
`Debug` output.

The observed `authorization` attribute has no reviewed value-to-policy mapping.
The parser therefore reports only `not_declared` or `declared_unverified` and
sets `authorization_decisions_available=false`. Authenticated retrieval,
refresh and policy interpretation remain production-unavailable until an
approved canary supplies evidence; no empty or fabricated catalogue is used as
a fallback.

## L3 TCP tunnel behavior

This section describes the legacy raw L3 family. It remains useful for
regression detection and older gateways, but it is not the production
replacement path for the observed gateway.

Static inspection of the authorized official x86_64 Linux package shows a
staged L3 transport with separate command/data tunnels. Text-relative evidence
is generated by `ec-protocol-map`; absolute addresses and vendor bytes remain
local to the restricted analysis directory.

The observed TCP opening sequence is:

1. Connect a TCP socket.
2. Send an 82-byte, client-owned TLS-shaped synchronization preface.
3. Read exactly 122 bytes from the server.
4. Send a 43-byte, client-owned TLS-shaped acknowledgement preface.
5. Send a 76-byte client message.
6. Read exactly 40 bytes as the server message.
7. Validate the server reply for the requested tunnel role.

The official client checks successful exact reads for the 122- and 40-byte
messages. Static evidence does not show a content comparison for the 122-byte
server preface. The independent engine must still treat it as opaque until an
approved black-box test demonstrates what validation is required.

### Client message

The 76-byte client message has this observed layout:

| Offset | Length | Encoding | Meaning |
| ---: | ---: | --- | --- |
| 0 | 5 | bytes | `17 03 01 00 3c`, a TLS-shaped application-data header |
| 5 | 3 | zero | reserved |
| 8 | 4 | ASCII | `JJYY` |
| 12 | 4 | little-endian u32 | tunnel role, currently `0..8` |
| 16 | 32 | zero | reserved |
| 48 | 16 | opaque | decoded `sslctx` bytes `32..48` |
| 64 | 4 | zero | reserved |
| 68 | 4 | little-endian u32 | observed zero |
| 72 | 4 | role-specific | `ffffffff` for roles 0/1, zero for 2/3/4, transformed auxiliary value for 5/6/7/8 |

Roles 0 and 1 open or reconnect the command tunnel. Static call sites identify
roles 5/8 as the new/reconnect TCP send path and roles 6/7 as the
new/reconnect TCP receive path. Roles 2-4 remain intentionally unnamed.

### Server message

The 40-byte server message must begin with ASCII `AABB`. Its little-endian u32
at offset 4 is checked as follows:

- command roles 0/1 use a separate command-reply handler;
- roles 2/3/4 accept the common reply without an additional status check;
- send roles 5/8 require status `2`;
- receive roles 6/7 require status `1`;
- unknown roles fail closed.

The remaining server fields are opaque and must not be assigned semantics
without additional evidence.

For command message type `0` (`SEND_IP` in the reviewed official client), the
following fields are evidenced:

| Offset | Length | Encoding | Meaning |
| ---: | ---: | --- | --- |
| 8 | 4 | native/network address bytes | virtual-interface address |
| 12 | 4 | little-endian u32 | payload-encryption flag (`0` or `1`) |
| 16 | 4 | native/network address bytes | LAN address |
| 20 | 4 | little-endian u32 | UDP port |
| 24 | 4 | little-endian u32 | compression flag (`0` or `1`) |

Addresses and session material remain memory-only. Command type `3` is
`SERVER_RESET`: the reviewed client closes the command socket, waits three
seconds, and retries a fresh command role `0`. Command role `1` is reserved for
ordinary reconnect after an accepted session. The Rust probe implements one
bounded reset retry. It does not loop indefinitely or treat receipt of a valid
`AABB` frame as proof that the command tunnel was accepted.

### TCP data frame

The observed outer frame is bounded to 1600 bytes:

| Offset | Length | Encoding | Meaning |
| ---: | ---: | --- | --- |
| 0 | 4 | ASCII | `IPCP` |
| 4 | 4 | little-endian u32 | total frame length, including the 12-byte header |
| 8 | 4 | little-endian u32 | channel/transform input; exact semantics remain unproven |
| 12 | variable | opaque | payload, at most 1588 bytes |

The official receive path rejects a bad magic, total length below 12, or total
length above 1600. It waits for the full declared frame before processing it.
The payload may pass through a session-dependent transform before being
written to the virtual interface; that transform is not implemented yet.

The send-side liveness frame is an 88-byte `IPCP` frame containing a synthetic
76-byte IPv4 ICMP packet. Its runtime-derived addresses, checksum inputs, and
payload text are not yet sufficiently specified, so the independent code does
not fabricate a heartbeat.

### Legacy behavior-derived implementation boundary

`src/tunnel.rs` implements the evidenced legacy layouts, bounds, server status
rules, session-context slicing, command-open reply, and handshake ordering,
using synthetic fixtures. The two client-owned preface byte sequences are
supplied through a version adapter and are not copied into Git. The reviewed
x86 client constructs its 82-byte preface from a template plus a 32-byte
runtime region at offset 44; that behavior is adapter metadata rather than a
hard-coded vendor byte sequence. Live testing confirmed authentication,
`sslctx` availability, exact 82/122/43/76/40-byte wire exchange, valid server
magic, and the reset/reconnect control path. The approved account consistently
receives `SERVER_RESET`, so legacy command/data acceptance is not claimed.

## Modern TLS send/receive family

The active profile uses a separate modern control family. A normal,
certificate-verified TLS connection pipelines configuration and resource
requests and derives a 48-byte memory-only token from the ServerHello session
identifier and the authenticated 16-byte TWFID. No token byte is serialized.

Each special connection sends a bounded 64-byte control request:

| Offset | Length | Meaning |
|---:|---:|---|
| 0 | 4 | little-endian command: address `0`, send `5`, receive `6` |
| 4 | 48 | memory-only session token |
| 52 | 8 | zero reserved bytes |
| 60 | 4 | `ff ff ff ff` for address; reversed assigned IPv4 for data channels |

The address reply requires status byte `0` and contains the assigned IPv4 in
bytes `4..8`. Send and receive replies require status bytes `2` and `1`.
The address-control connection remains open while separate send and receive
connections are established. The address request is paced to start at least one
second after token acquisition; the reviewed reference and live HKUST(GZ)
gateway both show that an immediate request can be rejected transiently.

The special transport has one deliberately narrow ClientHello contract:
TLS 1.1, a 32-byte session ID beginning `L3IP`, RSA with RC4-128-SHA, reviewed
compression offers, and one heartbeat extension. `special_tls11.rs` implements
only the required RSA key exchange, TLS 1.0/1.1 PRF, Finished validation, and
RC4-SHA record protection. It fails closed on every other negotiated suite,
version, compression mode, certificate decision, MAC, or handshake shape.

Approved live runs established address, send, and receive channels and carried
campus HTTPS traffic through the native userspace TCP stack and SOCKS5
frontend. The desktop's exact/suffix PAC then loaded the campus site in an
isolated Chrome profile without changing system DNS or global proxy settings.
A SOCKS5 UDP exchange currently receives no reply from the selected live
target, but closing the pending exchange no longer panics or degrades the
subsequent TCP path. Reachable live UDP, sustained load, sleep/resume, and
failure-injection recovery remain release gates.
