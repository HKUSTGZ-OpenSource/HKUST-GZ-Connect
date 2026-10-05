# Browser host configuration and locale projection

- Status: Proposed M2 source checkpoint; exact-head/platform and whole-wave acceptance required
- Owner: Desktop maintainers; accountable maintainer heeh02
- Last verified: 2026-10-05
- Applies to: post-v2.0.3 source after `main@06408ce4b99c18679d1cb06e4e6407f0c44cb55b`
- Supersedes: host option/default validation and live locale projection algorithms in the Browser root

## Responsibility and boundaries

The bounded constructor initializer reads only the originally declared options, once and in their
original order. It validates Workspace providers/controller, normalizes locale/profile/home and
optional callbacks, writes the same25 Root fields and returns the original native constructor
ports. It does not spread unknown input keys, read credential-service contents, invoke optional
providers, create a native window, persist settings or establish another mutable configuration.

The Root remains the sole holder of these fields. Service identities, profile/account/workspace
keys, partition, frozen presentation copy, neutral defaults, callback receiver and first-error
order remain unchanged. Native Window/Tab/Session, navigation/routing, credential/MFA and Engine
owners still receive their original services; no new policy or storage implementation is added.

The25-line locale owner uses bounded getters/setters and presentation effects. Locale and
translator update before window/title/message/Workspace/toolbar effects; missing/destroyed windows
retain the new strings without native effects. It has no timers, retained locale copy or pending
work. Current failures keep their original cause and effect order. Root's compatibility method
delegates without adding a Renderer symbol or IPC API.

Both responsibilities are placed behind existing Browser Session/Toolbar entrypoints. No new
production graph node, cross-domain edge or dependency is introduced. Existing native resource
and lifecycle algorithms are not relocated into configuration.

## Evidence and corrections

Four actual Root baseline contracts pass before movement: defaults/no implicit window, services/
profile/translator identity, first validation error, and ordered live-language effects. Independent
configuration and locale cases additionally cover exactly bounded field writes, opaque services,
declared-option read order, per-host policy identity, invalid dependencies, live getters,
repeated missing-window projection and preserved failure causes.

An intermediate extraction omitted the raw `campusPreload` constructor port; existing tests caught
it and the original argument was restored. A new native test incorrectly expected Main's long
window title to remain after the Renderer updates its own short document title. The same failure
was reproduced with the original committed Root and unchanged existing owner bodies in an isolated
native fixture. The test now checks the exact Main title effect and the actual Renderer/native
final title separately, without changing production title behavior or its timeouts. A newly added
test initially guessed the neutral partition string; it now uses the existing public constant.

Real Electron switches the live toolbar English/Chinese, observes native title projection,
exactly one Workspace/toolbar refresh per switch and unchanged window/Session/tab IDs.
Marker: `native Browser host locale projection: PASS`. Prior narrow/standard/wide, keyboard,
credential/page/route/entry/creation/teardown contracts remain. No GUI/CSS/motion redesign.

The new source test recursively inspects Browser class declarations/expressions, including Root,
against the existing600-line owner ceiling. Root683 ->598; host initializer53 and locale owner25.
Browser source842 ->757; the file growth cap ratchets downward. Main662/20 direct/35 effective/
170 transitive, production240/451, private-edge cap89 and zero root-test debt remain unchanged.
All11 pre-existing Session/Toolbar owner class bodies are unchanged in scoped source comparison.

Complete Desktop, exact-source architecture/syntax/secret/governance, native MFA/strict proxy,
Profile/relaunch/migration, routing/retirement and offline performance gates precede a single
remote batch. Exact-head required contexts, three-platform packages and actual-final-main checks
remain separate requirements. A numerical ceiling is not the requirement-by-requirement M2 exit
receipt or a full-goal completion claim.

## Risk and rollback

No wire/schema, dependency, persisted key, release/tag or installed-app change. Revert initializer/
locale owner/Root delegates, mirrored contracts, native fixture, downward ratchet and docs together;
no migration. This restores the original Root-held algorithms. No private/student fixtures,
live school/private Gateway canary, active Clash/system proxy/TUN/DNS/route operation.
