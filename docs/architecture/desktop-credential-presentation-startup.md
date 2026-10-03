# Credential presentation and startup projection ownership

- Status: Proposed bounded Persistence extraction for M3; not full composition acceptance
- Owner: Desktop Persistence maintainers
- Last verified: 2026-10-04 (local contracts/native fixtures; exact-head CI in the PR)
- Applies to: existing VPN/proxy credential owners, Persistence entrypoint and Main wiring

The existing VPN credential-access owner now projects the unchanged login-account
DTO. It asks its original presence method first: persistent credential, matching
Profile memory credential, then active Engine short-circuit further reads. Only
when absent does it call the injected current settings reader and return its
username. Errors remain the original `{ ok: false, username: '' }` result. No
credential opening, decryption, protected-storage prompt, cache or new data field.

The existing proxy-access owner exposes startup retirement of one trusted absolute
sidecar path with injected unlink. Startup and existing instance removal share one
unchanged unlink/error primitive: successful unlink or ENOENT is confirmed; other
failures remain false. Startup still ignores that outcome, as before; later strict
publication fails closed if replacement is unsafe. This is not a new cleanup or
durability policy. The new entrypoint rejects malformed declarations before I/O;
Main's existing canonical paths already satisfy the shape. Existing instance cleanup
retains its original error behavior even if an injected effect becomes unavailable.

Main declares both original paths and calls the public Persistence entrypoint at
the same moments: legacy projection before active Profile resolution, selected
projection before persistence recovery/owner-only validation. No deduplication or
reordering. Login IPC delegates to the existing VPN owner. Preload, channel schemas,
encrypted store/migration journal, Profile/Account/Workspace bindings, Engine, routing
and Renderer are unchanged; no real user file or secret is touched by test fixtures.

Baseline 32 credential/Main cases passed before movement. Seven new cases failed
with missing entrypoints; final coverage adds fresh identity, suppression/read order,
bounded failure, exact-path removal, absence/denial, malformed declarations, real
disposable file/sibling preservation, leaf-symlink non-following and unchanged owner
failure handling. The native Main fixture seeds both disposable paths under its own
temporary userData and observes retirement plus the unchanged login DTO. The existing
Windows platform-smoke entrypoint adds a native integration covering both disposable
paths, sibling preservation, actual directory-unlink refusal and login suppression/
read boundaries. Standalone portable unit cases run in the Desktop suite; Windows
coverage is recorded separately. The leaf-symlink unit case remains skipped on Windows.

Main falls 689 -> 674 lines with direct/effective/transitive metrics 20/35/170 and
private-edge inventory/cap 101 unchanged. The downward line ratchet is enforced;
no production module or dependency is added. Numeric targets alone do not prove
M3 completion: Main's locale/recovery-notice/resource-feed state still needs semantic
ownership review. Broader M1/M2/M5, governance and reporter outcomes remain separate.

Rollback restores Main's two cleanup blocks/login projection, owner entrypoints,
contracts, Windows integration case and the previous line ratchet together. No stored
schema or upgrade migration changes. Native/synthetic/package checks do not establish
an installed-app or live-school result; no release or system-network change is authorized.
