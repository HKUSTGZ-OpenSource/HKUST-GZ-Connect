# ADR-0033: Desktop compatibility proxy default

- Status: Accepted by maintainer instruction; implementation pending review
- Owner: Desktop and Security maintainers
- Last verified: 2026-09-05
- Applies to: Desktop settings defaults after 2.0.0

The maintainer requested strict local proxy authentication be disabled by default for compatibility
with local clients including Clash and SSH tools. New Desktop settings and a missing current-schema
value therefore normalize to false. Explicit true/false values in supported persisted security
schemas remain unchanged; the existing version-1 migration repair remains unchanged.

The listener remains loopback-only. Compatibility permits unauthenticated local use, including by
other local processes/users. Strict authentication remains an explicit option. Credential storage,
MFA, Profile isolation, routing and the independent root CLI's authenticated default are unchanged.
This does not claim to resolve port conflicts, proxy loops or all SSH configuration errors.

Rollback restores the previous default for new settings. Existing persisted choices are not rewritten
in either direction; no schema or user-data migration is required.
