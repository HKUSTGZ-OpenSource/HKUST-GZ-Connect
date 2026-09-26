# Independent Rust Engine instructions

- Inherit the root `AGENTS.md` and read `independent/ARCHITECTURE.md` plus the affected specification.
- The production Engine is independent of Electron, Desktop persistence and global system routing.
- Authentication produces an authenticated session or a typed failure. Transport, DNS and proxy
  layers do not reinterpret credentials or challenges.
- Compatibility probes, binary observation and clean-room tools never enter the production Engine
  path or release package.
- Do not guess vendor endpoints, field names, OTP shape, channel mapping or success semantics.
- Secret-bearing values remain bounded and zeroized where enforceable; never add them to errors,
  events, logs or fixtures.
- Keep the password-only production path working while generic MFA remains evidence-gated.
- Prefer `pub(crate)` and one public module entrypoint; do not expose internals for test convenience.
- Move orchestration out of `src/bin/ec-engine.rs` behind tested application services instead of
  raising its size budget.
- Preserve wire compatibility or version/negotiate a change explicitly with contract tests.

## Minimum validation

Run from `independent/` with the pinned Rust toolchain:

```text
cargo fmt --all -- --check
cargo clippy --locked --all-targets --no-default-features -- -D warnings
cargo test --locked --no-default-features
```

Changes to compatibility tools or feature boundaries also run both Clippy and tests with
`--no-default-features --features compatibility-lab`. Production/release commands never enable
that feature. Default-mode compile-fail doctests and the dependency-graph test must remain enabled;
laboratory-mode tests are additional coverage, not a replacement for production tests.

Run the synthetic auth-control fixture for Auth/Control changes. Network-performance, package and
authorized live compatibility evidence are separate gates and must be reported separately.
