# Desktop proxy access lifecycle owner

- Status: Proposed bounded M3 extraction; not complete Main composition
- Owner: Desktop Persistence credentials maintainers
- Last verified: 2026-09-29
- Applies to: candidate based on development `main@be57d4d`, not published v2.0.3

`ProxyAccessCoordinator` lives in the existing public
`desktop/lib/persistence/credentials/proxy-credential.js` entrypoint. It owns process-local
references to the encrypted-store-backed stable proxy credential and the generation-bound
ephemeral credential. Main injects the existing store, exact helper-sidecar path, current Profile ID,
private sidecar write effect and filesystem unlink effect. No new runtime module, generic IPC,
Renderer projection or credential storage format is introduced.
Main's pre-ready best-effort removal of an old sidecar stays in its original startup position;
this candidate does not reorder that bootstrap safety boundary.

The owner lazily loads one stable credential, requests the existing owner-only sidecar write before
copying an Engine input, constructs the existing `EphemeralProxyCredential`, and zeroes both copied
buffers in `finally`, including constructor failure. Clearing the active credential still requires
the expected generation when supplied. Stale Engine closes cannot remove a newer sidecar; the
existing `cleanupProxyAccessForEngineClose` keeps that decision. The exact Basic challenge remains
gated first by Browser WebContents ownership in Main and then by the active Engine credential's
generation, loopback host and port. A Profile switch revokes the active credential, attempts
sidecar removal and destroys the stable credential; quit retires the sidecar/stable secret after
the existing Engine stop envelope. Unknown or failed sidecar removal does not claim success.

Main retains thin callback names so Engine, recovery, Integration Center and Profile-switch owners
consume the same injection contract. It no longer keeps its own mutable stable/active proxy secret
references or implements their copy/zeroization sequence. The candidate lowers Main from 895 to
864 lines; direct/effective/transitive dependency counts remain 30/44/170, within unchanged
architecture caps. The below-800/24 and final 500–700/20 M3 targets remain open.

Synthetic owner tests cover lazy reuse, exact Profile/sidecar binding, zeroization on success and
failure, generation-gated clear, exact proxy challenge, Profile revoke under a failed unlink,
quit cleanup and redacted inspection. Existing Windows private-file, strict/compatible proxy,
Engine lifecycle, Profile-switch, migration and exact package gates must be recorded for the final
candidate. Synthetic tests are not real Gateway traffic, credential storage on another user's
machine, or a released installer. No real credentials, cookies or private Browser profiles are used.

Rollback the owner, Main wiring, contracts and this record together. Published tags, installed
applications and user-owned persistent files remain unchanged.
