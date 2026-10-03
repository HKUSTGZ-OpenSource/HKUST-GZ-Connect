# ADR-0036: Explicit gateway-default export intent

- Status: Proposed; source candidate, not released
- Owner: project maintainers
- Last verified: 2026-10-03
- Applies to: Desktop Integration Center; extends ADR-0005 without managed client operations

## Decision

The same `clash_mihomo_yaml` adapter accepts an optional closed `routingMode`:
`rules-only` (existing/default behavior) or `gateway-default` (explicit user selection).
Old requests retain their behavior. SSH cannot accept a gateway-default intent. No Profile,
Workspace, credentials, settings schema, Engine wire format or gateway capability is changed.

Gateway-default adds a minimal standalone Clash profile (`mixed-port: 7890`, or 7891 when
the app's SOCKS listener uses 7890; loopback-only, rule mode), then terminal
`NETWORK,udp,REJECT` and `MATCH,<current local SOCKS node>` rules. The generated inbound
never equals its upstream SOCKS port. This is deterministic output, not a scan of installed
client state or a guarantee that another application does not already occupy that port.
Gateway bypass and explicit direct rules remain higher priority. Literal IPv4/IPv6 gateway
origins use address CIDR bypass rules rather than a DOMAIN rule that cannot match IP-only requests.
The unsupported UDP path must not silently fall through to DIRECT. This mode requires a
Mihomo / Clash Meta core supporting NETWORK rules; classic-core compatibility is not claimed.

No named website, deployment-specific gateway or public resolver is hardcoded. No gateway rules
are guessed or downloaded by Desktop. The export delegates unmatched TCP traffic; policy and
DNS inside Engine remain the authenticated gateway/transport owners' responsibility. Delegating
traffic does not prove internet access or successful remote DNS on a particular deployment.

## Authority and privacy

The routing choice exists only as an in-memory export intent. It does not switch a client,
read subscriptions, import existing client files, change system routes/DNS/TUN, or persist a
new default. Prepared bytes and their mode are owned by the existing one-use, bounded export
transaction. Confirmation rechecks Profile/Account/Workspace/credential/policy bindings and
writes exactly those bytes. A change to another selection cannot rewrite a pending payload.
The Renderer sees a value-free delegation warning, never generated credentials or content.
Existing YAML without a routing comment remains accepted for compatibility.

## Evidence and limits

Unit tests distinguish both modes, closed IPC, terminal-rule validation, explicit exceptions,
IPv4/IPv6 bypass, legacy YAML, listener/upstream collision rejection and secret erasure. The
port-collision regression failed before the convergence repair. A separate native-core fixture uses synthetic
SOCKS/loopback endpoints and a temporary data directory, with DNS listener, TUN and controller
disabled. It tests YAML parsing separately from routing and verifies that an unmatched hostname
arrives at SOCKS unchanged in gateway mode. Explicit direct exceptions still reach loopback.
Hosts mappings are absent for the forwarded test domain so they cannot pre-resolve it into an IP.

The fixture does not read the installed client's profile or controller. No real account login,
gateway DNS response, real website access, classic Clash core, Windows/Linux native core or
post-import third-party state is claimed. Rollback removes the optional mode; existing requests
continue to use rules-only behavior. Existing exported files are user-owned and never rewritten.
