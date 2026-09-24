# Windows cleanup-warning investigation and owner-record repair

- Status: Candidate repair; user-reported disconnect cause remains unconfirmed
- Owner: Desktop / release maintainers, PR #106
- Verified: 2026-09-09
- Runtime source: `420f17d97cfe2a802c6f07f4c11eb2f2178cbfeb`
- Prior fixture-only sources: `4584fd1f64f1c0040381077208f52436d9c95939`,
  `52a4a76de9ed27e11abec717b65793140d788068`

## Report and verified defect

The maintainer reports 2.0.2 showing the cleanup-unconfirmed warning both during initial connection
and after intermittent disconnection. That one message has several producers: pre-spawn orphan
cleanup, post-spawn Windows owner-record writing, explicit disconnect, and reconnect/recovery after
an unclean stop. The screenshot alone cannot distinguish them or establish an MFA/Clash cause.

The Windows owner writer had a confirmed production defect: it created a temporary file, renamed
it, then called existing-file `ensureOwnerOnly`. An elevated Windows token can create files owned
by Administrators, so tightening correctly refuses them. Main catches this failure and stops the
new Engine with the same user-visible cleanup warning. Existing native owner-record regressions
were red on this path. Unlike the earlier fixture-only repairs, this is a production change.

The writer now uses the existing atomic private-file implementation: protect the newly created
temporary file before publication, rename, then verify the committed file. Failed temporary
protection preserves the previous record; failed committed verification removes the unverified
new record and throws, so Main still stops the unowned Engine. PID/path matching, record schema,
no-follow reads, stop budgets and fail-closed reconnect policy remain unchanged.

This fixes a reproducible **startup** cause. It does not prove the same cause for the reported
intermittent disconnects. Nonzero/unconfirmed Engine stops still intentionally prevent automatic
retry. Manual-reconnect behavior and bounded structured diagnostics are requested; no user password,
OTP, Cookie, account identifier or raw school response is needed or recorded here.

## Native and portable evidence

- Native Windows owner/supervisor/stress/Main boundary suite: **29 passed / 0 failed / 0 skipped**.
  Includes real private-file creation/replacement, independent PowerShell ACL verification and
  100 ownership replacements. No real Engine was killed and no school session was opened.
- Mac equivalent: **28 passed / 1 Windows-only skip**.
- Mac and designated 5070 Linux full suite: **1,292 total / 1,281 passed / 11 skips / 0 failures**.
- Native Windows full suite: **1,292 total / 1,200 passed / 52 failures / 40 skips**. This is the
  current candidate's result, not a green release gate. Remaining failures require attribution.
- Architecture, exact-source syntax (470 files), indexed secret, install-script and governance pass.

Focused command from `desktop/`:

```sh
node --test test/unit/connection/engine/engine-owner-private-write.test.js test/unit/connection/engine/engine-supervisor.test.js test/engine-lifecycle-stress.test.js test/main-engine-exit-boundary.test.js
```

Full commands use Node 24 and existing dependency paths on each designated host. Windows log:
`C:\Users\RBMS\work\hkustgz-202-engine-owner-full-20260909.log`; Linux log:
`/home/owner/work/hkustgz-202-engine-owner-full-20260909.log`. Mac log:
`/tmp/hkustgz-202-engine-owner-mac-full-20260909.log`.

## Separate fixture corrections

Settings and credential tests initially had **12 failures / 2 passes** on native Windows. Their
synthetic initial JSON files lacked Windows private ACLs, and the credential fixture forced the
macOS implementation on every OS. They now initialize private synthetic files and use the native
platform; **16/16 native tests pass**, including two new rejection-before-write cases.

Rollback fixtures now protect synthetic state/blob/intent files before exercising schema and
crash-recovery logic. Native tests pass **12 / 1 existing platform skip**, including two new
insecure-file rejection cases. The mock secret storage remains synthetic, not proof of a real
Windows credential vault. No production persistence/credential policy was weakened.

The fixture-only full Windows checkpoint at `52a4a76` was **1,288 total / 1,192 passed / 56 failed /
40 skips**. Keep these dated snapshots separate rather than assuming all failing paths have one cause.
Failure-set comparison also found `replacement between lstat and opened descriptor fails closed`
failed in that intermediate run but passed in the subsequent full run. Its production/test files
were not changed here; that instability needs separate investigation and is not credited to the
owner-record repair. The 52-failure snapshot is not a stability or release acceptance claim.

## Remaining acceptance and rollback

The new runtime is not yet packaged, installed or released; an existing app reporting 2.0.2 does
not automatically contain it. Full Windows acceptance, installer/upgrade verification, the exact
user disconnect reproduction and any live-school canary remain outstanding. No protected GitHub
merge, tag, release, Actions build, Organization transfer or settings change ran.

Revert the owner-writer change with its added tests to restore the previous writer; the record
format and user data need no migration. Fixture-only commits are independently revertible. Do not
delete user AppData or bypass cleanup to work around this report.
