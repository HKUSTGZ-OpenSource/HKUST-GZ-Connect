# Desktop Routing resource ownership

- Status: Proposed bounded M3 extraction; not full Main/M5 completion
- Owner: Desktop Routing maintainers
- Last verified: 2026-10-04 (local source and synthetic native checks)
- Applies to: existing DomainRoutePolicyStore source observation and context retirement

Main supplies its once-created Profile resource snapshot directly to the existing
Routing owner instead of retaining a mutable `serverCampusResources` variable.
The owner retains that same array reference without normalization, cloning or
eager provider reads. Its stable `serverResources` reader resolves the current
private source. Function-valued providers remain lazy and receive the store as
their call receiver, as before. The reader is now store-owned rather than the
incoming function itself; cached readers therefore follow source retirement.

`clearServerResources` replaces only that private observation with a new empty
array. Repeated reads share the replacement reference until the next retirement;
each retirement replaces it, matching Main's previous assignment. A retired
provider is not invoked again and cannot repopulate the policy through the reader.
Input resources are not mutated. No reload, write, emit, Browser/Engine operation,
route normalization or policy decision is added by clearing.

Main retains the existing injected context-switch effect order: clear memory
credential, clear Routing source, clear error/browser presentation, then clear
connection presentation and return true. Existing Profile/Account/Workspace
leases, transaction barriers, relaunch and persisted rules are unchanged.

Resolver, normalization and PAC rendering bodies remain byte-identical. Before
retirement, reviewed resource exact routes retain their precedence. Afterward,
only their source is empty; user rules, custom resources, school/partner fallback,
private-host safety and external/browser default routing retain their semantics.
No new production module, dependency, barrel, IPC, schema, credential or system
network change is involved. Main falls 668 to 667 lines with its cap ratcheted
down; direct/effective/transitive metrics remain 20/35/170 and private-edge cap 98.

Three new owner cases fail before the clear seam exists, then pass. They cover
source/reference ownership, stable cached readers, lazy provider call context,
retirement and no repopulation, route/PAC agreement and exact persisted bytes.
The existing native Profile-switch fixture observes actual Main construction
and its actual retirement through a test-process-only subclass. The portable
native filesystem integration evaluates Main's actual cleanup callback, retains
effect order and is in the explicit Windows CI test list. Platform evidence is
recorded separately; synthetic cases are not live-school acceptance.

Rollback owner/Main/fixture changes and the downward budget together; no stored
data migration is needed. Published 2.0.3 and the installed app are unchanged.
Final M3 review still must assess the residual composite admission/presentation
callbacks and reconcile all acceptance evidence; size targets alone do not close
M3, M1/M2/M5, governance or the full goal.
