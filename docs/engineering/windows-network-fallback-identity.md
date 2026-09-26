# Windows network fallback identity

- Status: Proposed
- Owner: Desktop / Network Environment maintainers; issue #163
- Last verified: 2026-09-27
- Applies to: candidate Windows network-environment fallback and Connection Overview selection

## Problem and scope

Issue [#163](https://github.com/HKUSTGZ-OpenSource/HKUST-GZ-Connect/issues/163) records a
synthetic offline reproduction: when PowerShell inspection fails, a Windows adapter alias such as
`Ethernet 2` is also used as its projected ID. The public schema accepts only bounded ASCII IDs,
so that interface is dropped and an explicitly saved source address cannot be resolved. This is a
conditional bug reproduction; it does not establish the cause of issue #127.

## Proposed candidate behavior

- For Node-derived Windows fallback inventory, derive a stable ID as `win:` plus the first 60
  lowercase hex characters of SHA-256 over the exact UTF-8 alias. The complete alias is hashed
  without trimming, normalization or truncation. The resulting 64-character ID fits the existing
  schema; a detected collision fails closed.
- Keep the adapter alias as the display name. When PowerShell succeeds, match its adapter record by
  that alias and retain its existing `if:<index>` identity. The fallback hash is hidden in the UI
  only for Windows IDs with the explicit `win:` hash shape; the internal selection ID is retained.
  Unknown adapter kind is presented as unknown, not physical.
- Persisted underlay selection remains the source IP only. The fallback ID is transient; no settings
  schema or migration change is proposed.
- Engine underlay arguments remain a paired interface ID and source IP. On Windows, the current
  Engine binds the local source address; it does not apply the interface name as a physical-device
  bind. The hash is therefore a schema-safe identity, not proof of a physical adapter route. This
  candidate makes no OS route, proxy or DNS changes.

## Evidence boundary and rollback

Synthetic offline tests cover PowerShell rejection and invalid JSON, alias hashing/collision,
healthy alias matching, source-address selection and UI type labels. They do not prove behavior on a
Windows device, physical route selection, package acceptance or a real-school connection. Issue #127
remains open and is not attributed to this conditional reproduction. Until review and required
platform/package validation complete, this document describes a proposed source candidate, not a
merged or released behavior. Reverting the candidate leaves the persisted source-IP setting and its
existing schema unchanged.
