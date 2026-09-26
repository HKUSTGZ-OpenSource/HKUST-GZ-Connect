# ADR-0034: Explicit compatibility laboratory build boundary

- Status: Proposed; implementation requires Security/Release review
- Owner: Rust Engine and Security maintainers
- Last verified: 2026-09-26
- Applies to: `independent/Cargo.toml`, library exports and research binaries
- Parent: M4 in `../architecture/modularization-plan.md`

## Context

The production Engine and research tools shared unconditional public library modules and archive/
disassembly dependencies. A string guard against one probe import was not compiler-enforced
isolation. Five negative import doctests all failed on the baseline because the imports compiled.

## Decision

Keep one Rust crate and the existing Electron/Rust stack. The non-default `compatibility-lab`
feature owns `adapter`, `binary_watch`, `probe`, `protocol_map` and `watch`. Their five CLI targets
require the feature. Six existing dependencies become optional under it: `flate2`, `iced-x86`,
`object`, `tar`, `xz2` and `zstd`. No versions or lockfile entries change. Static liblzma selection
is retained when the laboratory is enabled.

Default and shipped builds continue with `--no-default-features`, without the laboratory feature.
Those five module names are unavailable to the compiler and the six dependencies are absent from
the normal dependency graph. The shipped credential-free `ec-gateway-probe`, production protocol
parsers and synthetic authentication fixture are deliberately not classified as these research tools.

Explicit laboratory builds keep the existing APIs and command behavior. They are development
artifacts, not application release inputs, and enabling a feature does not authorize live testing,
credential use or vendor-package access. The lifecycle-test feature remains independently gated.

## Verification and limits

- Five separate production compile-fail doctests cover all removed module names.
- A positive laboratory doctest imports the same five names, preventing typo-based false evidence.
- A Cargo dependency-tree test verifies all six dependencies absent by default and present with opt-in.
- Production, laboratory and lifecycle-fixture Clippy/tests are run separately.
- Existing CI job names, triggers, permissions and production build commands remain unchanged;
  laboratory Clippy/tests are added within the existing Engine job to preserve research coverage.

This is a default-production build boundary, not per-target isolation when a caller explicitly
enables `compatibility-lab` for the entire crate. It does not attest that an arbitrary manually
copied lab-enabled binary is safe to ship. Existing release commands must remain feature-free;
package/signing and platform verification remain required. Stronger per-target separation or
additional package tripwires require their own reviewed evidence. No performance or real-network
improvement follows merely from removing optional dependencies.

## Consequences and alternatives

Research developers must add `--features compatibility-lab` when building the five tools. The crate
is not published; this is an intentional internal developer-interface change, with no wire,
configuration, Profile, credential, account or session migration. Feature unification remains a
reason to keep release commands explicit. A multi-crate rewrite was rejected for this bounded
step; string-only import checking was rejected as insufficient.

## Rollback

Revert feature requirements, conditional exports, dependency options, docs and their tests together.
The original unguarded research interface returns, so rollback reopens the diagnosed boundary.
No installed application or user data is changed by applying or reverting this candidate.

The existing compatibility-watch workflow explicitly opts in so this boundary does not silently
disable its research consumer. Current crypto/rc4/zstd versions and the lockfile are retained;
the feature only changes default dependency inclusion, not another dependency migration.

## Historical local candidate evidence — not current-tree acceptance

Base `ff9e808d3eb5020169f5196b207fa85739b429e1`, macOS arm64, Rust 1.97.1, locked offline
dependencies and a reused Cargo target with incremental builds disabled. Formatting and Clippy
with `--all-targets --no-default-features -- -D warnings` pass in default, `compatibility-lab`,
and `engine-lifecycle-fixture` configurations. The corresponding full test suites pass:

- default: 290 passed, zero failed, two performance tests ignored;
- laboratory: 302 passed, zero failed, the same two ignored;
- lifecycle fixture: 292 passed, zero failed, the same two ignored, including the 100-round soak.

The lower default count reflects deliberately excluded research tests; the separate laboratory
run retains them. The five compile-fail cases were first observed failing because the imports
compiled, then passing after gating. The positive import case and two-mode dependency graph pass.
An explicit default `cargo check --bin ec-watch` is rejected for missing `compatibility-lab`.
The lockfile is unchanged. Package-engine/release-assets tests pass 29/29 on the base candidate.
YAML readback against the base preserves triggers, permissions, job identities and every existing
step. Live main required contexts remain `secret-scan`, `package-verifier`, `desktop`,
`desktop-electron`, `windows-private-file`, `engine`, `offline-tests`; none is renamed here.
These results do not establish remote CI, signed-package or Windows/Linux execution.
