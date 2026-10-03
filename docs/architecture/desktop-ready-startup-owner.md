# Desktop ready-startup sequence

- Status: Current merged bounded M3 startup owner; not final Main composition or a released change
- Owner: Desktop App maintainers
- Last verified: 2026-10-03
- Applies to: merged #215; verified development `main@eb5a60743427286e5af5c6eafce48d4ddaa5b63d`, not v2.0.3

The existing App startup module holds the separately tested `DesktopStartupRuntime`
and `MultiSchoolStartupRuntime`. The first coordinates the application ready
sequence; the second retains provisioning/candidate authority. Main obtains the
ready coordinator through the existing App public entrypoint and injects the
unchanged domain owners/effects. No production module, generic IPC or alternate
storage/connection policy is introduced.

The ordered ready sequence is:

1. Guard and recover an active Profile switch.
2. Stop if recovery is relaunching; initialize the persistence owner otherwise.
3. Relaunch and stop if migration changes the selected storage mode.
4. Initialize multi-school candidates; request asynchronous deletion recovery.
5. Initialize logs and write existing bounded fixture markers.
6. Resolve locale, settings-read feedback and credential-recovery presentation.
7. Install the menu, publish the PAC, create the tray/window and bind the existing
   process-lifetime suspend/resume/activation hooks.
8. Start the network coordinator and automatic update notifications.

The owner captures one startup flight before injected callbacks execute; repeated
or reentrant calls cannot recreate services or replay a failed startup. Main keeps
the existing error dialog and exit policy. Deletion recovery remains asynchronous
and owned by its existing runtime; no new cancellation or quit policy is added.
The existing Shell/domain owners still handle shutdown. This sequence owner does
not claim to add removal of the application's process-lifetime event hooks.

Locale fallback and the second settings read remain separate. PAC failure appends
to an existing browser notice, rather than concealing persistence/recovery failure
or preventing the normal window/tray. Profile and migration relaunch boundaries
return before ordinary services. Startup does not inspect credential contents,
replace Engine state authority or modify system/third-party network configuration.

Five obsolete App composition re-exports have no production, fixture or test
consumer in the tracked tree and retire; their underlying domain APIs/files remain
unchanged. Composition members fall from 20 to 16 (including the new coordinator),
and three exact private-edge exceptions retire from 108 to 105. Main falls from
767 to 730 lines. Its direct/transitive dependencies remain 24/170; the explicitly
counted composition binding increases from 15 to 16, so effective dependencies are
39 rather than 38. No debt is hidden or budget raised: caps now freeze Main at
730 lines/24 direct/39 effective and the App composition at 16 members.

Before movement, existing order/read-boundary contracts and real isolated Main,
storage migration and initial-network fixtures pass. New public-seam tests first
fail because the coordinator is absent, then cover exact order, single flight,
both relaunch gates, terminal failure, locale/settings fallback, retained PAC
notices, deletion diagnostics and capability preflight. Original source contracts
follow the new owner and still verify Main's exact Profile/storage/relaunch effects.
The tests do not prove a real school login or a user's actual upgrade.

Rollback the startup class/public binding, Main wiring, source-contract seam and
downward budget/edge ratchets together. There is no user-data migration, installed
application replacement or release. Main still has 24 direct dependencies and 730
lines, above the final 500–700/20 target; #81 and the full convergence goal stay open.
