# ADR-0039: Reviewed private Gateway resolution and typed diagnostics

- Status: Proposed ADR; implementation released in 2.0.6, formal ADR approval not asserted
- Owner: project maintainers
- Last verified: 2026-11-07 (release/source metadata; original observation was 2026-11-04)
- Applies to: implementation in published `v2.0.6` at `541091d7422132a98e0eca534f58e80c4f0fe931`

## Implementation status

The source change entered main through [#292](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/pull/292)
at `77c7498b4a93bdbab61d500c10271674786ddbc0` and shipped in
[2.0.6](../../RELEASE_NOTES_2.0.6.md). It was not in the 2.0.5 app observed below.
This records the released implementation, not a newly accepted ADR decision or permission to
extend the exception to another school.

## Evidence and decision

The installed 2.0.5 Engine rejected the system-resolved private IPv4 peer of the
built-in HKUST(GZ) Gateway before reading credentials. A separate credential-free
TLS connection to the same domain completed with standard certificate-chain and
hostname verification enabled (TLS 1.2). This verifies that endpoint's TLS identity
in the observed environment, not a completed VPN login, tunnel or campus access.
No private address, certificate body, account data or raw response is stored here.

Enable ADR-0016's existing `reviewedPrivateGatewayAllowed` switch only in the
reviewed HKUST(GZ) profile and its matching Desktop/CLI Engine configurations.
Update the package manifest digests. Resolve through the system resolver as before;
do not hardcode the observed IP, introduce an external resolver/fallback, alter
the host proxy/TUN/DNS/routes, or silently grant the exception to custom schools.

All existing forbidden scopes, mixed public/private sets, peer membership,
immutable origin, TLS hostname/chain validation and generation binding remain
unchanged. The existing reviewed exception accepts all-private RFC1918/shared/ULA
sets; it is not a per-machine allowlist or authority for arbitrary origins.

## Errors and compatibility

Introduce domain kind `GatewayAddressRejected` and additive Event API v1 code
`GATEWAY_ADDRESS_REJECTED`. Only forbidden/private/mixed address policy rejection
uses it. Malformed configuration/port/identity stays `CONFIGURATION_INVALID`;
ordinary DNS lookup failure keeps its pre-login network classification.
Desktop displays actionable bilingual guidance, classifies the rejection terminal,
and points to inspection rather than automatic retries or reinstall instructions.
Do not parse diagnostic stderr to reconstruct state.

No schema, profile/account key, origin, protocol-family or credential-binding
revision changes. The existing built-in policy field is delivered through the
hashed package manifest and per-launch Engine binding, not an account migration.
Keeping Profile revision 1 preserves existing stored account/workspace bindings;
changing that identity would require a separate migration. Older Desktop versions
still reject safely but show a generic message for the new bounded code.

## Validation, handoff and rollback

Synthetic tests cover reviewed private/public IPv4/IPv6, forbidden and mixed sets,
unreviewed custom denial, typed event serialization/normalization, terminal retry
classification, bilingual messages and hashed Desktop/CLI profile consistency.
Preserve current credential and upgrade tests. Record executed Mac/Node/Rust checks
and omissions in the handoff; Mac evidence does not establish Windows or Linux
native acceptance. No GUI layout change or Engine authentication rewrite is needed.

Windows/WSL is the primary development environment. The original Mac contribution was scoped
for review and native verification; that preparation record grants no further authority to merge,
release, replace an installed app, or change other work queues. A source rollback reverts
the reviewed flags/digests and diagnostic additions; no user data is removed.
