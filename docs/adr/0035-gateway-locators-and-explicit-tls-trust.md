# ADR-0035: Gateway locators and explicit origin-bound TLS trust

- Status: Proposed; source candidate for review, not a released support claim
- Owner: project maintainers
- Last verified: 2026-10-01
- Applies to: Gateway onboarding, HTTPS session and Modern token acquisition; issue #197
- Amends: ADR-0003 root-only input and custom hostname-only restrictions, ADR-0022 and ADR-0028 probe argv

## Decision

A user-supplied locator is not an authentication origin. Accept host[:port], an
HTTPS root, or an HTTP/HTTPS redirect entry with no userinfo, query or fragment.
The credential-free native helper performs at most three GET redirects, with
no cookies, request bodies, authorization headers or retained response bodies.
Only the initial locator may be HTTP. Every next hop must be HTTPS; locator
HTTPS uses normal PKI. Loops, private/mixed/forbidden address sets, missing
Location and a final non-root endpoint fail closed through the existing public
Gateway connector. Proxy environment and certificate overrides stay scrubbed.

The final HTTPS root is a candidate, not authority to send credentials. It may
contain a public IP or non-default port. The existing Main-owned, expiring,
one-use confirmation shows that exact origin before isolated Profile creation.
Do not re-resolve a locator during authentication, silently fail over to a new
origin or transfer a credential envelope across origins. A changing redirect
target requires another check and explicit confirmation.

Standard PKI is unchanged by default. An optional, administrator-verified
64-hex-character leaf SHA-256 is explicit user input in the advanced onboarding
section. Never infer it from a first network observation or Browser trust. The
confirmation displays both origin and fingerprint. Main binds the grant into
the newly provisioned custom Profile, whose origin is immutable. Reviewed
Profiles cannot acquire a local trust override.

The additive Engine `gateway_tls` object contains exactly `origin` and
`leaf_sha256`; its origin must equal `base_url`. One neutral TLS owner supplies
HTTPS authentication, the credential-free probe and Modern token TLS. The
confirmed exact leaf replaces PKI name/issuer identity checks only for that
origin. The verifier still checks DER validity, certificate dates, exact server
name binding and TLS 1.2/1.3 handshake signatures. Pin change, wrong port,
wrong host, malformed or expired certificate fails closed. The legacy special
TLS data plane continues binding its leaf to the verified token TLS leaf.

## Compatibility and scope

Absent trust fields serialize exactly as before; existing Profile data,
credentials and HKUST defaults are not migrated. A pinned custom Profile is an
additive schema extension: older application versions reject the unknown field
rather than downgrade its trust. Rollback requires removing the new inactive
Profile and recreating it in a supported application, not rewriting existing
credentials or stripping the trust field.

This does not add an authentication family. Keep compiled provider selection
closed and capability-bounded. Password/Modern L3 is implemented; CAPTCHA,
OTP, SSO, WebVPN-only and other transports remain evidence-gated, explicitly
unsupported. A public discovery version is not proof of authentication or L3.

## Acceptance evidence

Synthetic checks cover origin/port drift, malformed grants, matching and changed
leaf, validity bounds, credential-free argv, unsafe locator shapes and address
restrictions. Native metadata checks cover locator resolution, recognition of
the compiled family and rejection of absent or mismatching trust grants.
Metadata/TLS evidence does not establish account authentication or tunnel
acceptance. Public reports contain capability and validation summaries only:
never deployment addresses, user identities, certificate fingerprints, private
configuration, authentication data or private-environment observations.
