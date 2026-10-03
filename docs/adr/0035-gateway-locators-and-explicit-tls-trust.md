# ADR-0035: Gateway locators and explicit origin-bound TLS trust

- Status: Proposed; source candidate for review, not a released support claim
- Owner: project maintainers
- Last verified: 2026-10-03
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

Standard PKI is unchanged by default. When ordinary discovery cannot verify a
valid self-issued leaf because its issuer is unknown, the credential-free helper
may complete a TLS handshake with signature verification to observe its leaf.
It closes without sending application data, then uses that exact leaf for one
fixed credential-free discovery request. Schema 2 explicitly reports
`https_identity_valid: false`, the observed fingerprint and required consent.
This is observation, not server identity proof or authentication authority.

Main requires a one-use, expiring confirmation bound to the active context,
exact origin and observed fingerprint. The user-visible action is explicitly
"Trust on first use and add"; its trusted IPC request must carry
`trustCertificate: true`. No Profile or persistent trust grant is created before
that action. Fingerprints are automatically recorded and compared on subsequent
connections, with details collapsed by default. First-use trust cannot prove
the destination's identity, particularly for plaintext redirect entries, and
the warning states this limitation. Certificate change or expiration blocks
future authentication, not an automatic pin update.

Non-self-issued, malformed and expired certificates and PKI hostname/signature
failures are not eligible for this convenience path. An administrator-provided
fingerprint remains an optional advanced input. Browser trust is never reused.
Reviewed Profiles cannot acquire a local trust override. Observation/fallback
fits the existing native probe process deadline; no timeout budget is raised.

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

The convergence review reproduced UnknownIssuer short-circuiting WebPKI before
its name check. First-use observation now runs the public Rustls DNS/IP name
verifier before recording an observed fingerprint. Wrong DNS/IP names have a
RED/green synthetic regression; the positive case uses the existing generated
certificate's actual SAN, not a mismatched test name. No extra trust root,
global exception, new dependency, private key or weakened assertion is used.
