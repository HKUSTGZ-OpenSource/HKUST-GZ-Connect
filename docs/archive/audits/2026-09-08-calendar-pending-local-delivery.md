# Calendar pending-week local delivery

- Status: Historical local acceptance receipt, not a public release
- Owner: Desktop / student workspace maintainers
- Verified: 2026-09-08
- Runtime source: `35dac9915f4b305cdb5cd67907dec4675a6165ab`
- Review: existing PR #106; no additional PR for this repair

The user reproduced a large loading-state replacement while selecting an uncached week.
The installed 2.0.2 candidate did contain a week cache; a never-read week nevertheless took the
legacy state-only rendering path. Earlier download/MFA changes did not address this UI defect.

Loading now retains the selected week's seven-day grid with a small bilingual sync status.
Only geometry can be reused from the prior week: no previous-week events or false empty result
are shown. Pending grid height is bounded to 140px miniature / 180px full. Cached refresh still
retains the existing DOM; errors retain last-good data and explicit authentication revocation
still removes personal cache data. No backend/API, credential or data-schema change is included.

Evidence:

- RED: uncached-week unit regression had no grid; fixed regression passes.
- 13 calendar/cache Node tests passed on Mac.
- Native Electron schedule navigation passed 360/440/960/1440 widths and 150% zoom, seven-day fit,
  zero horizontal overflow, cached-week navigation, retained refresh DOM, details and pending state.
- Linux 5070 full Desktop suite: 1,270 passed / 6 platform skips.
- Architecture, exact index secret and syntax gates passed; syntax tree
  `a5ea5a5c12c1102410ef17aa815d68c2c44e0e9b` covered 469 files.
- Mac arm64 package verifier and deep/strict signature verification passed. Packaged calendar JS,
  CSS and i18n bytes were compared against the checkout.

Local delivery:

- Replaced and relaunched `/Applications/hkustgzconnect.app`; version remains local-test 2.0.2.
- Prior ASAR: `3c58f7c431a19af3b6d746c22150d79e46b23092fa91c54aad393737a4c2d1bd`.
- Installed ASAR: `705d83f90356cf3b1973d723f4d785765cba4adbba53843394d32c5a013baf0c`.
- New process and installed archive were read back. The native workspace displayed the timetable.
- Existing arm64 Engine/helper artifacts were reused because their source was unchanged from the
  prior candidate; no Rust rebuild is claimed. The local bundle is Apple Development signed,
  not a notarized public package. Extra x64 build copies were excluded and the bundle reverified.
- User-data storage was not modified by the installer. One rollback app remains at
  `/tmp/hkustgz-calendar-app.ZyS0xW/previous-installed.app`; the duplicate generated new app was removed
  after its archive matched the installed copy. The temporary dependency symlink was removed.

No GitHub merge, release, tag or Organization transfer occurred. Windows/Linux installers were not
rebuilt. No manual school authentication, API probing or new-week live canary was performed.
The later native Renderer extraction PRs still need this behavior change carried across their
separate module boundary before integration; do not overwrite it with the older view implementation.

## Installed-artifact readback after repeated loading report

On 2026-09-08 the installed archive still matched `705d83f9…13baf0c`; the running process
started at 15:09:57, after the archive's 15:07:11 modification time. This rules out a process
started before that replacement, but does not date the user's screenshot or prove live API behavior.

The navigation fixture now accepts `HKUSTGZ_SCHEDULE_RENDERER` so the exact installed ASAR's
Renderer JS and CSS can be tested without extracting another app or accessing the user's profile.
It also holds the very first data request and asserts seven day headers, `aria-busy`, zero
invented events and absence of the old loading placeholder before releasing that request.

Executed from `desktop/` with the existing Electron 43.2 binary:

```text
HKUSTGZ_SCHEDULE_RENDERER=/Applications/hkustgzconnect.app/Contents/Resources/app.asar/renderer electron e2e/schedule-navigation.electron.js
node --test test/unit/renderer/schedule-cache.test.js test/unit/renderer/schedule-calendar.test.js
node scripts/check-architecture.js
node --check e2e/schedule-navigation.electron.js
```

Installed-artifact native navigation passed; checkout unit tests passed 18/18. Architecture and
syntax checks passed. Navigation covers cached refresh, failed refresh, uncached week, date,
details, keyboard, 360/440/960/1440 widths and 150% zoom. All data is synthetic, HTTP(S) requests
are denied by the fixture, and a separate temporary profile is used. Screenshots are under
`/tmp/hkustgz-installed-calendar-readback/`. No production source, installed app, user data or
release was changed in this readback. The real-session reproduction remains unconfirmed and
requires the maintainer's bounded live-canary authorization; offline success is not that evidence.
