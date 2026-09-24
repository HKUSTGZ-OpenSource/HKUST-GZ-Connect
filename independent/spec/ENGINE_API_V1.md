# Engine NDJSON API v1

`ec-engine` reserves stdout for one UTF-8 JSON object per line. Each line,
including its newline terminator, is at most 1024 bytes and is flushed before
the next lifecycle action. Human-readable diagnostics use stderr only.

When the opt-in `--control-api-v2-stdin` transport is active, the same stdout
stream can additionally contain the independently versioned, at-most-2048-byte
`control_hello`, `control_result`, and `control_error` responses defined in
[`ENGINE_CONTROL_API_V2.md`](ENGINE_CONTROL_API_V2.md). No v1 event shape or
ordering rule changes, and launchers that do not opt in receive only this v1
contract.

The optional `--generation <u64>` argument identifies one desktop connection
attempt. It defaults to `0` for older launchers. Generation is present on every
`state_changed` and final `stopped` event so a delayed event from an old engine
cannot mutate a newer connection.

The mutually exclusive `--socks-auth-optional-stdin` and
`--socks-auth-stdin` flags do not change the event schema. Without either flag,
credential stdin is the gateway username/password pair. With either flag,
stdin contains gateway username, gateway password, local proxy username, and
local proxy password as exactly four lines. No credential value is accepted as
an argument or emitted as an event.

Optional mode accepts both SOCKS5 `NO_AUTH` and RFC 1929, preferring `NO_AUTH`
when the client offers both. UDP ASSOCIATE is retained only for a control
connection that selected `NO_AUTH`; selecting RFC 1929 returns
command-not-supported (`0x07`) for UDP. Strict mode accepts only RFC 1929 and
always returns `0x07` for UDP ASSOCIATE. This per-connection decision prevents
an authenticated control connection from creating a conventional
unauthenticated UDP relay.

Only strict mode enables Basic-authenticated HTTP proxying on the same loopback
listener. HTTPS/WSS use CONNECT. Ordinary absolute-form `http://` and `ws://`
requests are authenticated before method/target validation, rewritten to one
origin-form request, and streamed with bounded headers and body framing. Proxy
credentials, proxy headers, hop-by-hop headers and fields named by
`Connection` never reach the origin. The default and optional contracts reject
HTTP-shaped first packets. These behaviors do not add credential or destination
fields to the NDJSON event schema.

## Events

```json
{"type":"hello","apiVersion":1,"capabilities":["password","l3","udp"]}
{"type":"state_changed","state":"connecting","generation":7}
{"type":"state_changed","state":"authenticating","generation":7}
{"type":"state_changed","state":"preparing_tunnel","generation":7}
{"type":"client_ip_assigned","family":4,"address":"10.20.30.40"}
{"type":"dns_mode","mode":"gateway"}
{"type":"listener_ready","port":6180}
{"type":"state_changed","state":"connected","generation":7}
{"type":"network_unhealthy","reason":"data_plane_disconnected"}
{"type":"state_changed","state":"stopping","generation":7}
{"type":"fatal_error","code":"NETWORK_DISCONNECTED"}
{"type":"fatal_error","code":"AUTH_INDETERMINATE","secondaryCode":"AUTH_CLEANUP_UNCONFIRMED"}
{"type":"state_changed","state":"stopped","generation":7}
{"type":"stopped","reason":"network_unhealthy","generation":7}
```

Valid state values are `connecting`, `authenticating`, `preparing_tunnel`,
`connected`, `stopping`, and `stopped`. `preparing_tunnel` means password
authentication produced an owned Gateway session and the Engine is establishing
Modern L3; supervisors that predate this additive state may ignore it and still
use the later `listener_ready`/`connected` events. DNS modes are `gateway`,
`system_fallback`, and `disabled`.
Address family is the numeric IP version `4` or `6`; the assigned address is
never included.

Stable fatal codes in v1 are:

- `INVALID_ARGUMENTS`
- `CONFIGURATION_INVALID`
- `CREDENTIALS_INVALID`
- `AUTH_FAILED`
- `AUTH_REJECTED`
- `AUTH_INDETERMINATE`
- `GATEWAY_PRELOGIN_UNAVAILABLE`
- `AUTH_PROTOCOL_INVALID`
- `AUTH_EXPIRED`
- `AUTH_LIMIT_EXCEEDED`
- `AUTH_CLEANUP_UNCONFIRMED` (secondary code only)
- `UNSUPPORTED_AUTHENTICATION`
- `DATA_PLANE_SETUP_TRANSIENT`
- `DATA_PLANE_SETUP_FAILED`
- `DATA_PLANE_SHUTDOWN_FAILED`
- `LOCAL_LISTENER_FAILED`
- `NETWORK_DISCONNECTED`
- `LOGOUT_FAILED`
- `SHUTDOWN_SIGNAL_FAILED`
- `EVENT_OUTPUT_FAILED`

`AUTH_FAILED` remains accepted for older Engine builds. New authentication
failures use the narrower codes: only a verified structured credential
rejection emits `AUTH_REJECTED`; Gateway DNS/connection/response failures before
the password POST emit `GATEWAY_PRELOGIN_UNAVAILABLE`, which may be retried within
the configured connection budget because no password was submitted. An uncertain
password POST or response emits terminal `AUTH_INDETERMINATE`; schema violations
emit `AUTH_PROTOCOL_INVALID`.
`secondaryCode` is omitted unless it is `AUTH_CLEANUP_UNCONFIRMED`, which adds
remote-cleanup status without replacing the primary failure.
`DATA_PLANE_SHUTDOWN_FAILED` is a primary code used only when normal terminal
cleanup cannot close and join the userspace data plane inside its bounded
deadline. If an earlier primary failure already exists, that earlier code is
preserved and the local shutdown diagnostic remains on redacted stderr.

Final stop reasons are `user_requested`, `startup_failed`,
`local_service_failed`, `network_unhealthy`, `logout_failed`,
`shutdown_failed`, and `event_output_failed`.

## Privacy boundary

Events never contain usernames, passwords, session identifiers, tokens,
assigned IP values, destination addresses, URLs, or free-form error text. The
client address event exposes only its address family. Fatal events expose a
stable code and, when applicable, one allowlisted secondary cleanup code;
detailed, redacted diagnostics remain on stderr.

During migration, the four historical readiness messages remain on stderr so
an older desktop parser can still recognize them. They are not part of the
stdout protocol and may be removed after all supported desktop versions consume
API v1.
