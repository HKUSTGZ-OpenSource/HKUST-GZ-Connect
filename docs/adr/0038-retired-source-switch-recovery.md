# ADR-0038: Recover a switch from a retired source credential revision

- Status: Proposed for #276
- Owner: project maintainers
- Last verified: 2026-10-30
- Applies to: startup switch recovery; not installed/released until package acceptance

## Problem

Before #275, a live switch captured the startup account credential revision. A later
credential save or removal advanced the persisted revision, while the switch wrote
a prepared journal with the stale source revision. Source validation then failed;
the same journal prevented the next startup from completing recovery.

## Decision

Only the startup recovery runtime may accept a strictly advanced source
`accountCredentialRevision` in a `prepared` journal. Profile ID/key/revisions,
account key/revision, workspace key and epoch must remain identical. The freshly
validated directory record and pre-ready authority must agree exactly, including
the current credential revision. The recovery-only runtime cannot start a new
live switch. Live source validation remains exact.

The source credential is being retired, not used for authentication or transferred
to the destination. No credential is decrypted by this check. The original journal
is neither edited nor discarded. Existing before/after activation receipts,
destination identity checks, Browser gating, Engine termination, proxy revocation
and commit/relaunch barriers remain mandatory. A decreasing revision, any other
identity mismatch, mixed/unknown activation state or failed cleanup stays blocked.

## Alternatives and risks

Deleting the journal would lose intent and cleanup evidence. Rebinding all source
fields would hide ownership corruption. Accepting changed revisions during live
switches would mask races. None is permitted. The narrow exception cannot prove
historical process timing; it proves that only the credential revision of the same
retiring identity advanced, which is sufficient without using that credential.

## Evidence and rollback

Unit tests cover forward-only revision, all identity fields, directory mismatch,
ready-state rejection and strict live validation. The native fixture creates both
an ordinary interrupted switch and the old stale-source failure in synthetic
private storage, then exercises recovery and bidirectional selector/relaunch.
Test execution results are recorded in the PR, not inferred from test presence.

No schema migration. Reverting restores strict rejection of stale journals;
successfully committed switches retain the existing storage format. No user-data
reset, host DNS/route/proxy change or real gateway test is part of this decision.
