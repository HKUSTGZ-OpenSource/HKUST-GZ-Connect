# Desktop settings recovery ownership

- Status: Proposed bounded Persistence extraction for M3; not full M3/M5 completion
- Owner: Desktop Persistence maintainers
- Last verified: 2026-10-04 (local source and synthetic native checks)
- Applies to: Main's existing settings-recovery observation and startup presentation

`DesktopPersistenceRuntime` owns the original settings-recovery observation and
its localized startup text. Main delegates the existing legacy-store callback,
App startup observation/setter and presentation getter to that owner. Construction
and observation do not read storage, translate, emit, clone or validate the
observation. The original reference is retained; replacing a raw observation does
not implicitly replace its localized text.

App startup still selects locale, loads settings, translates the observed kind,
then applies credential recovery silently before creating the ordinary UI.
The existing notice aggregation remains byte-identical: additional settings text
first, credential text second, joined by a newline. An unrelated recovery error,
browser notice or diagnostic notice is not cleared. The existing optional
`getAdditionalNotice` presentation effect remains compatible.

No settings-store recovery algorithm, Profile/Account/Workspace identity, schema,
credential handling, IPC/preload surface, translation dictionary, Engine or
system network behavior changes. No production module or dependency is added.
Main falls 669 to 668 lines, with its budget lowered accordingly. Its direct,
effective and transitive dependency counts stay 20, 35 and 170. Routing's cached
resource feed and the final semantic Main review remain separate M3 work.

Three owner tests fail before the extraction and pass afterward, covering
reference identity, separate translation, silent publication and notice order.
The portable native-filesystem case exercises Main's actual callback via the
public legacy adapter with synthetic corrupt documents, both with and without
a valid backup. It also lives in the existing file selected by Windows CI, so
macOS results do not stand in for Windows results. The actual Electron Main
fixture uses a test-process-only observation through the real callback and
checks both restored/default notices through ordinary startup and bounded IPC.
The fixture uses the selected locale rather than assuming the host speaks Chinese;
explicit Chinese/English selections exercise both observation kinds locally.
It does not claim a real user's corrupt storage or a live Gateway was tested.

Rollback the owner fields/methods, Main bindings, fixtures and downward budget
together. No data migration is needed. This extraction does not change the
published 2.0.3 package or the installed application; exact-source platform
package and final-main results belong to the pull-request receipt.
