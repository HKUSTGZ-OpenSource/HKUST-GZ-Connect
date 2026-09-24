# Engine provider contracts

The production engine uses stable provider boundaries so a gateway feature or
transport revision can be added without putting vendor protocol logic in the
desktop, proxy frontend, or lifecycle supervisor. These contracts are Rust
interfaces in `engine/provider.rs`; they do not change Engine API v1, CLI
arguments, or the current password + L3 runtime behavior.

## Capability semantics

Every known capability has one of three states:

- `Supported`: a reviewed implementation is selectable through the provider.
- `Unsupported`: the capability is recognized, but this build has no reviewed
  implementation. Requests fail immediately and explicitly.
- `Unavailable`: an implementation exists, but the selected gateway profile or
  provider instance cannot use it. Requests also fail immediately.

Neither `Unsupported` nor `Unavailable` may return an empty success value or
fall back to another protocol. Unknown secondary authentication is its own
unsupported capability rather than a password failure.

The current production model is intentionally narrow:

| Capability | State | Adapter |
| --- | --- | --- |
| Username/password authentication | Supported | `ProductionPasswordAuthProvider` |
| CAPTCHA, SMS, token/TOTP, certificate, HID, SSO, device auth | Unsupported | Explicit typed provider error |
| Unknown secondary authentication | Unsupported | Explicit typed provider error |
| L3 data plane | Supported | `ModernL3TransportBackend` |
| WebVPN transport | Unsupported | `UnsupportedWebVpnBackend` |
| Resource catalogue | Unsupported | `UnsupportedResourceProvider` |
| Resource authorization decision | Unsupported | No value-semantic adapter |

`OfflineResourceDocumentProvider` is a supported provider only for bytes that a
caller already owns. It performs no network access, keeps the XML in zeroizing
memory, and returns the bounded `resource_catalogue` v1 model. That model uses
opaque handles and separates a serializable redacted presentation view from
non-serializable launch material. Its authorization-decision capability is
`Unavailable`: raw vendor values become only `declared_unverified`.
The presentation fields and logging boundary are specified in
[`RESOURCE_CATALOGUE_V1.md`](RESOURCE_CATALOGUE_V1.md).

The offline provider is not the production resource provider. Parsing a
sanitized fixture does not prove authenticated retrieval, authorization
semantics, refresh behavior, or safe desktop presentation. Production therefore
continues to return `Unsupported(ResourceCatalogue)` and
`Unsupported(ResourceAuthorizationDecision)`. Likewise, observing a `WebVpn`
endpoint does not prove its transport contract.

## Interfaces

`AuthProvider` accepts secret-bearing `AuthRequest` values without implementing
`Debug` and returns either an authenticated session or a provider-owned
challenge type. This permits a future evidence-backed multi-step adapter
without putting vendor challenge fields into the shared contract. The current
adapter uses an uninhabited challenge type and accepts only the password
variant. An observed MFA continuation maps to a typed unsupported capability;
no challenge exchange is invented.

`ResourceProvider` returns a provider-owned catalogue type. The current
production provider always returns `Unsupported(ResourceCatalogue)`. The
offline provider exists for fixture/probe validation and reports catalogue
parsing as supported while authorization decisions remain unavailable.

`TransportBackend` connects a provider-owned session to a provider-owned data
plane. `ProductionPasswordAuthProvider` ends after password authentication and
returns an auth-only `AuthenticatedGatewaySession` containing the cookie jar,
logout endpoint, and opaque gateway session identifier. Only
`ModernL3TransportBackend` fetches and parses the L3 configuration, acquires a
Modern token, applies certificate binding and retry policy, and opens the data
plane. Its typed `ModernL3Connection` carries both the data plane and gateway
DNS results, so transport state is never written back into the auth session.

Provider errors preserve ordinary engine errors, while capability failures stay
machine-distinguishable inside the Rust boundary. `ec-engine` maps a typed
unsupported authentication method to the stable
`UNSUPPORTED_AUTHENTICATION` code without serializing the method, challenge, or
server response. A verified structured password rejection maps to
`AUTH_REJECTED`; request/response outcomes that cannot be confirmed map to
`AUTH_INDETERMINATE` after password submission. Gateway availability failures
before the password POST map to retryable `GATEWAY_PRELOGIN_UNAVAILABLE`; invalid
structured responses map to `AUTH_PROTOCOL_INVALID`. `AUTH_FAILED` is retained only for compatibility with
older Engine builds. Secondary-authentication responses are logged out under a
bounded deadline before the primary error is returned. If that cleanup cannot
be confirmed, the primary code remains intact and the event adds the secondary
`AUTH_CLEANUP_UNCONFIRMED` code.

## Adding a provider

1. Collect authorized official-client evidence and bounded sanitized fixtures.
2. Add the capability as `Unsupported` before adding any protocol code.
3. Implement one provider or backend in a vendor-specific adapter module.
4. Change the capability to `Supported` only after contract fixtures and an
   approved parity test pass.
5. Add a mock-provider contract test that contains no network access or real
   credentials.
6. Keep unsupported and unavailable cases as negative tests; never substitute
   password auth, L3, public DNS, or direct HTTP as an implicit fallback.
7. For resources, separately prove authenticated retrieval, refresh/expiry,
   authorization-value semantics and launch behavior. Passing the XML parser
   is not sufficient to enable the production capability.

The contract tests in `tests/provider_contracts.rs` compile generic consumers
against mock authentication, resource, and transport implementations. They
also prove that the production MFA, WebVPN, and resource placeholders fail
closed without touching a gateway. The offline resource fixture contains a
synthetic query token, user fields and opaque authorization strings; tests
prove none appear in the redacted view, safe summary, provider debug output or
errors.
