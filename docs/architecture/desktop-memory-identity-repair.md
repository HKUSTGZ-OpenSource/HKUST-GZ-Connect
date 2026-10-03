# Memory-only Control identity repair

- Status: Proposed bounded source repair for #226; not live-school or release acceptance
- Owner: Desktop Persistence/Main maintainers
- Last verified: 2026-10-04 (local contract/native reproduction; exact-head CI in the PR)
- Applies to: Main's existing Control snapshot identity injection

Main's callback referenced the removed `hasOneShotCredential` helper even though
memory presence now belongs to the existing VPN credential-access owner. The
normal empty snapshot short-circuits before identity evaluation, and a persistent
identity short-circuits inside it. When a current Profile has only staged memory
input, or an active Engine without persistent identity, `get-state` instead failed
with `ReferenceError`. This is independent of Gateway/password authentication.

The only production correction delegates that term to
`vpnCredentialAccess.hasOneShot()`. Persistent identity -> current Profile memory
presence -> active Engine ordering remains unchanged. No duplicate broker, secret
opening/decryption, memory consumption, new stored identity or Renderer field. The
existing snapshot still masks ordinary account labels and keeps password presence
separate from connection phase. No auth/routing/schema/permission/locale change.

Three regression cases evaluate the actual Main callback with the real public
credential owner and production Control snapshot: matching memory, no/persistent/
wrong-Profile/Engine identities and short-circuit order. They fail before the fix
with the exact reference error, then pass without consuming staged input or exposing
it. The actual Main/guarded IPC fixture also fails before repair after explicit
synthetic memory-only save. A fixture-only availability adapter then verifies that
state is readable before any Engine connection and restores the real store for all
original retry/readiness/Renderer-loss/retirement assertions. No production switch
or changed deadline is added. Existing native Windows platform coverage evaluates
the same Main callback with its real access owner; native results remain distinct
from portable mocks and macOS evidence.

All production owners, dictionaries, preload/IPC schemas and Engine remain unchanged.
Main is still 669 lines, direct/effective/transitive 20/35/170, private-edge cap 98;
no dependency, production module or budget growth. Rollback restores the one old
reference, corresponding assertions and this record, but reintroduces the reproduced
failure. No user-data migration or installed-application operation is needed.

This source repair does not prove or close the original Windows report #127 or
portal calendar report #177. Full M1/M2/M3/M5/governance and final goal acceptance
remain separate; source/CI evidence is not an installed app or live Gateway outcome.
