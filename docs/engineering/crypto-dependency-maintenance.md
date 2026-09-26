# Crypto dependency maintenance

- Status: Proposed maintenance slice, pending exact-head and native acceptance
- Owner: Rust Engine maintainers
- Last verified: 2026-09-26
- Applies to: post-2.0.3 development source; not the frozen 2.0.3 artifacts
- Issue: #105
- Base: `b57c394c73e0b07a0076e26f58e1666e29f00135`

## Boundary and compatibility

Direct SHA-1 moves to 0.11 and rand to 0.10. HMAC 0.13 and MD5 0.11 are companion updates:
the existing TLS PRF combines HMAC-MD5 and HMAC-SHA-1, so both must share the new digest trait
generation. Updating SHA-1 alone does not compile against the old HMAC generic bound. This is API
maintenance, not a stronger wire hash, a TLS protocol change or permission to use legacy TLS
outside the existing verified vendor channel.

System entropy remains `SysRng` with rand_core's documented `UnwrapErr` adapter. Like the preceding
rand 0.8 `OsRng`/`RngCore` implementation, an OS entropy failure fails closed by panic; there is no
deterministic or weaker fallback. RSA 0.9 retains its required old rand_core generation via RSA's
public re-export, only at RSA encryption calls. No duplicate RNG policy or new direct dependency is
introduced.

The Cargo MSRV declaration becomes 1.88, matching the already locked `time 0.3.55` requirement
instead of the inaccurate 1.85 declaration. The pinned build toolchain stays 1.97.1. Six existing
nested conditionals become equivalent short-circuit let chains because the corrected MSRV activates
Clippy's corresponding check; no lint suppression or budget increase is used. Pinned-toolchain
acceptance is not a claim that a separate full Rust 1.88/native platform run occurred.

## Regression evidence

Before upgrading, a new regression passed the public HMAC-MD5/SHA-1 case-one vectors from
[RFC 2202](https://www.rfc-editor.org/rfc/rfc2202). The pre-existing fixed TLS PRF and RC4 vectors,
record authentication, secret zeroization, credential encoding and challenge/transaction tests stay
unchanged. The same HMAC vectors pass after migration.

Local macOS on Rust 1.97.1: formatting and warning-free Clippy pass; production tests are 308 passed,
zero failed, two performance tests ignored; lifecycle-feature tests are 310 passed, zero failed,
two ignored, including the 100-round real subprocess post-Transport soak. Native platform and
exact-head checks remain separate gates. No live Gateway, student credential or school MFA result
is inferred from these tests.

## Earlier backlog and deferral

The SHA-2, roxmltree, time/rustls, zstd and rc4 updates are already merged in earlier independent
PRs. The routine Dependabot queue is limited to one PR per ecosystem without suppressing security
updates. Electron 44 is explicitly deferred by the maintainer to preserve older-platform support;
it is not silently ignored or included in this Rust change.

No credential/persistence schema, routing, global proxy/DNS, Desktop GUI, provider capability or
timeout changes. Revert this dependency slice and its lockfile together if needed; immutable 2.0.3
tags and artifacts are not replaced by this post-tag source work.
