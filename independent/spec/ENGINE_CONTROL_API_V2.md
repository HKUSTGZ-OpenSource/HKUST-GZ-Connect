# Engine Control API v2

Engine Control API v2 is a small bidirectional control plane. It is separate
from both existing channels:

- gateway and optional local-proxy credentials remain on the bounded stdin
  credential contract;
- lifecycle and health output remains Engine Event API v1 NDJSON on stdout.

The control codec opens no public listener. In the initial cross-platform
transport, a supervisor opts in with the non-secret
`--control-api-v2-stdin` flag and keeps the already inherited private stdin
pipe open. The engine incrementally consumes exactly two credential lines (or
four when local proxy authentication is enabled), then interprets later bytes
as control frames. Without the flag the established read-to-EOF credential
contract is unchanged. Implementations must not place a control secret,
gateway credential, session token, URL, or network destination in CLI
arguments, diagnostics, events, or control frames.

Responses share the bounded stdout NDJSON stream with Event API v1. Their
`apiVersion: 2` and request IDs distinguish them; old v1 consumers ignore the
unknown response shapes. Before `listener_ready`, the inherited pipe is also
the supervisor-ownership boundary for the in-progress Auth/Transport attempt:
EOF or an accepted `control.close` cancels that attempt and performs bounded
session cleanup. If an in-flight synchronous syscall cannot reach a cooperative
cancellation point within the drain deadline, the Engine exits nonzero with
cleanup-unconfirmed instead of allowing the result to outlive its generation.
After listener readiness, EOF/`control.close` ends only the
optional control channel and leaves the established tunnel under ordinary
signal/process supervision. Neither case synthesizes a shutdown request.

## Framing and bounds

Each message is one UTF-8 JSON object followed by LF. A frame including LF is
at most 2048 bytes. EOF within a frame and unknown JSON fields are fatal to the
control connection. Version offers contain at most four entries, at most 32
requests may await supervisor completion, and only the 256 most recent request
IDs are retained for duplicate detection.

Every request ID is a non-zero unsigned 64-bit integer. IDs are scoped to one
control connection and must not be reused while retained.

## Handshake

The first successful exchange negotiates version 2:

```json
{"type":"hello","requestId":1,"versions":[2]}
{"type":"control_hello","apiVersion":2,"requestId":1,"capabilities":["engine.shutdown","request.cancel","control.close","provider.capabilities"]}
```

All later requests include `apiVersion: 2`. A missing handshake, duplicate ID,
unsupported version, or second hello receives a typed error and performs no
action.

## Minimal commands

Graceful engine shutdown is accepted before the supervisor receives a typed
local `ControlAction::Shutdown`:

```json
{"type":"request","apiVersion":2,"requestId":2,"command":{"name":"shutdown"}}
{"type":"control_result","apiVersion":2,"requestId":2,"status":"accepted"}
```

`cancel` names an active request by ID. Accepted shutdown requests have a
bounded 100 ms commit window so a cancellation received after the response can
remove the queued shutdown before engine teardown starts. `close` closes only
the private control connection; before listener readiness, process assembly
also treats loss of that owner connection as cancellation of the unfinished
connection attempt. These produce `ControlAction::Cancel` and
`ControlAction::Close`; the codec itself does not terminate processes or tasks.

Once that shutdown deadline has elapsed, pre-listener process coordination treats it as committed
state before polling a ready worker result or a later cancel frame. Timer-driver registration must
not extend the cancellation window or allow an Auth/Transport result to advance after commitment.
The existing bounded worker drain and domain-specific session cleanup still run.

Known but unimplemented provider capabilities can be queried only through the
closed enum in `ControlCapability`. They always fail explicitly, for example:

```json
{"type":"request","apiVersion":2,"requestId":3,"command":{"name":"require_capability","capability":"transport.web_vpn"}}
{"type":"control_error","apiVersion":2,"requestId":3,"error":{"code":"unsupported_capability","capability":"transport.web_vpn"}}
```

This is not a WebVPN, resource, or MFA implementation. The schema has no
arbitrary command payload and therefore cannot carry credentials, challenge
answers, gateway tokens, or destination addresses.

## Additive provider capability query

An official Profile-bound Desktop may request the selected production provider layers:

```json
{"type":"request","apiVersion":2,"requestId":4,"command":{"name":"provider_capabilities"}}
```

The response is exact-schema and contains the Profile revision and Engine generation plus two maps with the same
bounded capability keys:

```json
{"type":"provider_capabilities","apiVersion":2,"requestId":4,"profileId":"hkustgz","profileRevision":1,"engineGeneration":9,"compiled":{"auth.password":"supported","transport.l3":"supported"},"provider":{"auth.password":"supported","transport.l3":"supported"}}
```

The abbreviated example shows the shape; production reports every stable capability. A state is exactly one of
`supported`, `unsupported`, or `unavailable`. The selected provider layer may only keep or tighten the compiled
layer. The response never contains a username, account key, Gateway origin, endpoint, Cookie, token, DNS target,
credential or transport material.

If the Engine was not launched with a reviewed Profile binding, the request returns
`capability_context_unavailable`. Desktop binds the report to its short-lived account handle and active-context
epoch, adds Profile/ingress layers, and rejects a stale Profile or generation. Event API v1 hello and lifecycle
events are unchanged.
