# VPN credential selection

- Status: Current source contract
- Owner: Desktop Persistence maintainers
- Last verified: 2026-09-26
- Applies to: source after v2.0.3; published installers are unchanged

## Single selection authority

`openVpnCredential` in the existing `one-shot-vpn-credential.js` selects the
credential owner in Main's final synchronous connection snapshot. Profile/config
verification still precedes any credential access. Settings, generation and account
ownership are unchanged; neither the selector nor Renderer receives file paths.

A usable protected persistent owner retains priority. A missing owner uses the
existing profile-bound process-memory broker. The protected store's typed
`credentialStatus: unavailable` outcome may also use an explicitly staged matching
memory owner. Without that entry, the original unavailable error is retained.

Corrupt, failed-decryption, stale-context and unknown failures are not converted to
fallback success. This fixes an unavailable-store exception short-circuiting the
already supported memory-only path; it does not add another storage backend or
make Linux `basic_text` acceptable for persistence.

Memory input remains explicit, profile-bound, bounded and zeroized. Each connection
attempt gets a cloned one-use owner; the process broker remains available for
same-session retry until explicit replacement, context retirement or quit. It never
becomes a cross-launch auto-connect authority. Nothing is written by this selector.

## Evidence and rollback

Tests execute Main's actual initializer as well as the domain selector, covering
valid persistent precedence, missing/unavailable fallback, profile mismatch, other
failure kinds and owner disposal. The unmodified native Linux baseline fails before
Engine start with protected storage unavailable; synthetic native lifecycle checks
distinguish this case from a real school/Gateway login. No real credential is used.

Revert the selector, Main wiring and matching tests together. There is no schema,
ownership, protocol, system-network or installed-App migration. Windows report #127
requires its own reproduction evidence and is not closed by this bounded repair.
