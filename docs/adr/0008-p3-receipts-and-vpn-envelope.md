# ADR-0008: P3 legacy receipts and bound VPN credential envelope

- Status: Accepted as a non-activating P3b contract
- Production migration: not enabled by this ADR
- Parent contracts: [`ADR-0004`](0004-profile-account-workspace-scope.md),
  [`ADR-0007`](0007-p3-storage-foundation.md)

## Context

ADR-0007 can derive the future storage layout and persist a receipt-bound migration journal, but P3 still needs
two security-critical inputs before an orchestrator may touch existing state:

1. a stable snapshot receipt for every flat 1.x authority; and
2. one encrypted object that keeps the legacy username and password paired with their destination account.

Reading by path and hashing later would leave a replacement window. Migrating the current plaintext username
and encrypted password independently could commit a credential for the wrong account.

## Decision

### Legacy receipt collection

`legacy-flat-source-receipts.js` derives the exact existing paths from the normalized `userData` root. Callers
cannot supply arbitrary source files. The set includes settings/backup, VPN credential, routing/PAC, website
vault, certificate trust, Engine owner, the existing credential transaction, proxy credential/helper projection,
and current/rotated/retention log files. Each present source is processed through one no-follow descriptor:

```text
lstat and policy check
  -> Windows DACL verification when applicable
  -> O_NOFOLLOW open
  -> fstat identity/version comparison
  -> bounded chunked SHA-256 with immediate buffer clearing
  -> final fstat identity/version comparison
```

The comparison covers device/inode, size, mtime and ctime. POSIX sources must be regular, single-link and
owner-only. Missing files produce an explicit absent receipt; a file that disappears after observed presence is
an error. Receipt output contains only `present`, `bytes` and `sha256`, never file contents.

### VPN credential envelope

`vpn-credential-envelope.js` encrypts username and password together with:

```text
profileId / profileCredentialBindingRevision
accountKey / accountCredentialRevision
GatewayOrigin / ProtocolFamily
credentialVersion / updatedAt
```

Unknown fields, control characters, empty values, oversized values, an unavailable protected store and Linux
`basic_text` all fail closed. Decryption requires the exact expected binding before it returns a credential
owner. The owner keeps username/password in Buffers, redacts JSON/string/inspect output and supports explicit
zeroizing destruction.

Electron `safeStorage` accepts/returns JavaScript strings, so immutable temporary strings cannot be overwritten.
The implementation removes references immediately and clears parsed string fields; the persistent and
longer-lived owner remains Buffer-backed and zeroized.

### Encrypted envelope persistence

The active `profile-workspace-credential-store.js` owns the ciphertext below the account path together with
the Account document and credential transaction. It uses owner-only same-directory temporary files, file
fsync, atomic rename and directory fsync. Windows protects temporary files and verifies committed DACLs;
reads are bounded, no-follow and single-link. The earlier standalone envelope-store foundation was retired
after this transactional store became authoritative, avoiding a second persistence entry point.

## Activation note

This ADR originally described the pre-activation P3b boundary. The current runtime reaches the transactional
Profile/Account/Workspace credential store through `DesktopPersistenceRuntime`; Renderer and IPC still receive
no plaintext credential or direct persistence capability.

## File-stat precision addendum (2026-09-10)

The maintainer authorized the private correction, review and subsequent inclusion in 2.0.2.
The implementation requests native `bigint` path/descriptor stats for private-file reads,
permission hardening and receipt collection. Device/inode identity is compared without Number
conversion; receipt version checks retain reported mtime/ctime nanoseconds. A numeric adapter may
provide only safe integer identities; unsafe numeric identities fail closed instead of inventing
lost bits. Native Node supplies nanoseconds; legacy injected numeric timestamp snapshots retain
only their reported millisecond precision. This does not assert filesystem timestamp granularity
or eliminate every possible inode-reuse race.

Bounded sizes, modes/link counts and compatibility display timestamps remain numbers. Receipt and
credential schemas are unchanged: file identities and nanoseconds never enter receipt JSON,
Renderer DTOs or stored credentials. Windows ACL and POSIX no-follow/link/permission policies remain
mandatory. The internal private-read stat projection now carries BigInt identity/time fields;
callers needing display time retain numeric `mtimeMs`. Native compatibility, bounded-allocation
and replacement/hash-race fixtures passed on macOS, Windows and Linux. The combined candidate's
full Desktop suites also passed on each platform. This is source/fixture evidence, not proof of
installed-package behavior, independent human review or a completed release. The maintainer's
one-time review/check exception does not remove package-verification requirements.

## Deferred work

P3c must gate all flat writers, complete the existing credential/settings recovery first, collect receipts,
write the full destination tree, re-encrypt the legacy credential in memory, verify destination receipts and
drive the ADR-0007 journal through all-old/all-new recovery. Legacy authorization-store retirement and rollback
blob state remain separate required gates.
