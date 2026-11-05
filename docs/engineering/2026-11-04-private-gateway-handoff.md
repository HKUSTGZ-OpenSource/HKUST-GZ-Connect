# #282 — Gateway private-resolution fix handoff

- Status: Candidate implementation; pending Windows/WSL primary-maintainer review
- Owner: project maintainers
- Last verified: 2026-11-04
- Base: `c4dd13f9e65bcdf4a505ddfa8e49cfb0e2f2817e`
- Branch: `codex/282-private-gateway-diagnostics`; final commit/tree and CI recorded in the PR
- Authority: Windows + WSL owns primary maintenance; this Mac task is limited to #282

## Delivered scope

The current system resolution of the reviewed school Gateway was private. Strict
TLS chain and hostname validation succeeded without credentials. The old installed
Engine denied the address as `CONFIGURATION_INVALID`. The candidate enables the
existing reviewed-school private-peer exception only for HKUST(GZ), retaining
the immutable hostname, exact peer set, forbidden/mixed-scope rejection and TLS.
No observed IP is hardcoded or recorded; no third-party proxy/DNS/TUN/route is changed.

The Engine emits terminal `GATEWAY_ADDRESS_REJECTED` for address policy rejection;
Desktop displays bilingual guidance rather than reinstall advice. CLI pinned digest,
the reviewed profile, both Engine configs and the package manifest are synchronized.
No credential/account/workspace schema or revision migration is introduced.
See [ADR-0039](../adr/0039-reviewed-private-gateway-diagnostics.md).

## Executed Mac evidence

- Three new Desktop assertions were RED before the fix (reviewed policy, diagnostic,
  recovery action). Existing digest checks caught the CLI's old pin during integration;
  the pin was updated, not the integrity assertion removed.
- Node 24.22.1 `npm test`: 2,213 total; 2,197 passed; 16 platform skips; zero failed.
- Rust 1.97.1: `cargo fmt --all -- --check`, `cargo test --locked --no-default-features`
  and `cargo clippy --locked --all-targets --no-default-features -- -D warnings` passed.
  Local builds set `CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_PROFILE_TEST_DEBUG=0` and
  `CARGO_INCREMENTAL=0` to reduce generated disk usage; no repository budget changed.
- Native Electron 43.8.1: `main-integration.electron.js`, `main-profile-switch.electron.js`
  (normal/stale recovery and roundtrip), `main-custom-profile.electron.js` passed.
  macOS emitted sandbox-extension warnings for the dependency symlink; no assertion failed,
  and sandbox settings were not disabled.
- Credential-free candidate Engine startup, using the normal config binding and empty
  credential input, passed the previously failing address stage and returned
  `CREDENTIALS_INVALID`. This is deliberate missing input, not an attempted password login.
- Architecture, governance, install-script policy and CLI `bash -n` checks passed.
  The synthetic authentication-control E2E and native control-shell layout checks passed.
  Exact-tree syntax/secret results are recorded in the commit handoff/PR.

## Windows/WSL continuation

Fetch this branch in an isolated checkout; do not copy Mac `node_modules`, `target`,
installed application state or private school material. Use the pinned Node/Rust
versions and [host handoff](windows-wsl-handoff.md). Repeat the scoped test matrix
and required CI/package checks at the exact accepted commit. Native Windows
DACL/DPAPI/UI and Linux runtime acceptance are not inferred from this Mac run.

No full real-account authentication, tunnel/HPC request, three-platform installer,
installed-app replacement, merge or release was performed by this task. Review the
school-specific policy decision before merging; separately authorize any live login
or deployment. The installed 2.0.5 app remains unchanged until a reviewed update.

## Rollback

Revert the isolated change set, including profile/Engine/CLI digest updates. Do not
delete settings, credentials or switch journals. The prior public-only policy and
generic message return; no persistent migration needs reversal.
