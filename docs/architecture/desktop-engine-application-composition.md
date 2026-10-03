# Desktop Engine application assembly

- Status: Proposed bounded M3/M5 convergence; not final Main composition or a release
- Owner: Desktop Connection maintainers
- Last verified: 2026-10-03
- Applies to: candidate based on `main@45849231cd8e7820faf258b651ea4cebb11946b1`

The existing `engine-process.js` exposes `createEngineApplicationRuntime` as the
Connection application assembly entrypoint. It constructs the unchanged
`AuthChallengeCoordinator`, `EngineControlRegistry` and `EngineSupervisor`, and
creates existing Attempt/Termination coordinators with those exact shared owners.
Main supplies Profile, storage, presentation, network and application effects.
It no longer directly imports the three lower-level control/runtime/supervisor
modules or constructs an independently wired copy of those resources.

The assembly is effect-free: no process, credential access, timer, publication or
private-file operation occurs at construction. It is a frozen six-member API:
the three original owner objects, two bounded coordinator constructors and a
delegate to the exact existing orphan cleanup implementation. It is not generic
class/IPC dispatch or a second authentication, generation, retry or cleanup policy.
Callers cannot replace the shared Supervisor/Control Registry through Attempt
options, or substitute Termination's generation/retry/control ports. Remaining
caller effects retain their identity and the existing domain owners retain all
start/stop/disposal authority; the assembly adds no fake/no-op cleanup owner.

The module map declares the existing process file as a **file-level** entrypoint,
not a symbol-level security sandbox. Its original launch/native-resource helpers
and constructor export remain available. Renderer/Preload permissions, wire,
Profile/Account/Workspace ownership, private stdin ordering, credential zeroization,
Engine event authority and production/laboratory selection are unchanged.

The package binding gate recognizes this explicit assembly path and still follows
the exact packaged Attempt owner. New negative cases reject a substituted Main
assembly, unrelated Attempt constructor or unowned Supervisor binding; all original
missing Profile injection, argv digest, private frame and ordering failures remain.
Legacy direct/inline binding paths remain supported and fail closed as before.

Five new assembly tests initially have four failures because the factory is absent;
the missing-capability case already fails safely. After assembly they cover original
owner types/identity, no constructor effects, live generation delegation, matching
control cleanup, retained orphan refusal and injected side effects. Main exit/read
contracts follow the new seam rather than deleting assertions. Baseline Attempt,
Termination, exit and package contracts passed before movement. Exact-main native
acceptance of the base is separate from the post-change local/native/package gates.

Main falls from 730 to 723 lines and 24 to 21 direct imports. The production
transitive graph remains 170; no node is added. Three exact Main private-edge
exceptions retire and the inventory/cap falls 105 to 102. The reported App-expanded
effective metric falls 39 to 36, but it counts the existing App facade, not every
symbol on this six-member Connection API. This is a clearer domain boundary, not
a claim that six underlying responsibilities disappeared. Downward growth caps
freeze 723 Main lines, 21 direct and 36 App-expanded dependencies without raising
any budget. Final 500-700/at-most-20 Main composition and full M5 remain outstanding.

Rollback the assembly/Main wiring, package/source-contract seam, public-entrypoint
declaration and downward ratchets together. No persistent migration, installed
application, system/third-party networking or release/tag operation is included.
