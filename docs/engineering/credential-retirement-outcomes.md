# Credential retirement outcomes

- Status: Source candidate; not a released support claim
- Owner: project maintainers
- Last verified: 2026-10-02
- Applies to: Profile Workspace credential store and startup runtime; issue #199

Before credential mutation, the rollback owner returns an explicit outcome:

- `retired`: applicable legacy rollback material has been durably retired.
- `not-applicable`: this validated Profile does not own the HKUST legacy rollback domain.

The credential store accepts `not-applicable` only outside the reviewed HKUST
Profile. A boolean success is not a proof. A missing outcome, failed retirement,
or not-applicable claim for reviewed HKUST blocks before transaction or target
writes. Custom Profiles never inspect or delete another school's rollback data.

This fixes first credential saving for isolated custom Profiles without changing
credential envelopes, ownership, encryption, migrations or authentication.
The existing settings-write message means the save failed and credentials were
not committed; it is not a Gateway rejection or an instruction to change a password.

Regression evidence uses synthetic identities only: actual Electron credential
save, replacement and clearing, plus rejection of an inapplicable retirement
claim for reviewed HKUST. No live account authentication is claimed.
