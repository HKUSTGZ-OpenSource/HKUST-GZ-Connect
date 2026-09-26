# Engine argument ownership

- Status: Proposed M4 structural extraction for review
- Owner: Rust Engine maintainers
- Last verified: 2026-09-26
- Applies to: `independent/src/bin/engine_app/arguments.rs`

The ec-engine binary imports one private argument module using an explicit `#[path]` declaration.
`EngineArguments`, parsing, generation hints and fixture selection are visible only to the parent
binary module (`pub(super)`), not exported through the `ec_compat` library. Cargo targets, crate
dependencies and public/wire schemas remain unchanged.

The owner validates the existing CLI contract: config/listener arguments, paired source interface
and address, u64 generation, private control opt-in, mutually exclusive proxy-auth modes and the
compile-time-only lifecycle fixture flag. It does not read environment variables, files, stdin
credentials or the network. Unknown values continue to produce generic diagnostics without echoing
possible credentials.

Eleven source test functions move with their owner (ten active in either feature configuration).
The remaining lifecycle/control tests stay with their current owner. The existing argument tests
retain their identities apart from module paths.
`ec-engine.rs` falls from 2,515 to 2,140 lines on the current base; the private argument module is
392 lines. Boundary
tests enforce that reduced composition limit and a 600-line owner cap and include the new binary
subdirectory in the existing production probe-import guard.

This is a structural change, not a new protocol/provider capability or completed M4. Runtime
authentication, transport, control and shutdown orchestration still need further extraction.
Production rejects the test-only lifecycle argument; feature-enabled validation must continue to
exercise the private control/generation prerequisites. Existing offline process tests, Clippy and
format checks apply to both configurations. Real-school, installer and signed-artifact evidence
remain separate from these local checks.

Rollback the extraction and its boundary/path-map changes together. No settings, profile, account,
session or credential migration is involved; no installed native binary is replaced by this work.

## Current-base validation

This candidate is reconciled onto `main@1673009f71199141c6e54b23c1275f728f715554`.
The parser and all 11 moved test functions match the preceding production source after whitespace
and private visibility normalization. That comparison is supporting evidence, not semantic proof.

macOS arm64, pinned Rust 1.97.1, locked offline dependencies:

- `cargo fmt --all -- --check`: passed.
- `cargo clippy --locked --offline --all-targets --no-default-features -- -D warnings`: passed.
- `cargo test --locked --offline --no-default-features`: 307 passed, zero failed, two ignored.
- The same Clippy/test commands with `--features engine-lifecycle-fixture`: passed; 309 tests
  passed, zero failed, two ignored, including the 100-round real-process post-Transport soak.
- `node desktop/e2e/auth-control-fixture.js`: passed, synthetic private pipe only.
- Release-profile ignored offline SOCKS and netstack performance matrices: 18 and 27 cells passed
  unchanged disaster guards. They are loopback/in-memory evidence, not school/VPN throughput.

Required remote platform/package checks still gate merging. Native Windows/Linux, signed artifacts,
installed application behavior and live-school authentication are not established by these local
checks. M4 remains incomplete: the composition file still exceeds its final 800-line target.

## Historical candidate validation (not current-tree acceptance)

Base: `ff9e808d3eb5020169f5196b207fa85739b429e1`. Validated on macOS arm64 with
Rust 1.97.1, using the existing shared target and offline locked dependencies:

```text
cargo fmt --all -- --check
cargo clippy --locked --offline --all-targets --no-default-features -- -D warnings
cargo test --locked --offline --no-default-features
cargo clippy --locked --offline --all-targets --no-default-features --features engine-lifecycle-fixture -- -D warnings
cargo test --locked --offline --no-default-features --features engine-lifecycle-fixture
```

Default configuration: 301 passed, zero failed, two ignored. Fixture configuration: 303 passed,
zero failed, two ignored, including the real-binary 100-round post-Transport lifecycle soak.
The 26 default binary test identities were compared before/after, ignoring only the new module
namespace. Both Clippy configurations and formatting pass. Ignored tests are not acceptance
evidence. Windows/Linux execution, release package/signing and real campus behavior were not
validated by this extraction. No Actions workflow or release was triggered.
