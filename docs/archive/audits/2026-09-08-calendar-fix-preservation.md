# Preserve the delivered calendar fix through Renderer modularization

- Status: Historical review-chain acceptance; not a merge or release receipt
- Owner: Desktop Renderer maintainers, issue #79
- Verified: 2026-09-08
- Delivered behavior base: PR #106 `86a245c0ff0b2f2b861ac5994c19f54eec8ab83d`
- Native calendar synchronization: `3a8271442dc9cd178cfcdff6afd5793cefd3dc69`
- Tested final Renderer runtime: `3710796d7d3e3be1a7047aab38bdf9cbeacc35e5`
- Native fixture readiness correction: `b18c475d3e81dc1e25f2b4dbf512344ea8ab764b`

The module review chain had not inherited the last delivered uncached-week repair. The change was
ported into the existing controller/view boundary, retaining scoped CSS, bilingual copy, the
four-export public entrypoint, existing cache/expiry behavior and the compact seven-day pending
grid. The deleted legacy global module was not restored. Controller/view are 413/80 lines.

PR #108's local history includes the updated #106 base without rewriting public commits. The same
calendar code and tests were then carried into #109 and #110. This is local integration of review
branches, not a GitHub PR merge, installed-app replacement or import of the old backend chain.

Evidence:

- 96 rendered-state HTML comparisons against the delivered legacy implementation matched across
  four widths, Chinese/English, ready/empty/loading/failed, uncached-week navigation and clear-display.
- New pure-view tests ensure pending geometry has no old detail groups, no empty-result claim and
  remains bounded to 140/180px. The internal ready-geometry callback exposes only four numeric fields.
- Mac and Windows Node cache/view tests: 9 passed on each host.
- Linux 5070 full suite on `3710796`: 1,315 passed / 6 platform skips.
- Mac and native Windows Electron compared all computed styles and bounds to PR #106's stylesheet:
  five week width/zoom layouts, four detail dialogs and three refresh/loading states passed.
- Initial Windows A/B capture raced native resize/ResizeObserver, comparing different size modes.
  The fixture now waits within its existing bounded polling pattern for the requested native
  viewport and matching miniature/full mode; geometry assertions and budgets were not relaxed.
- The difference from `3710796` to `b18c475` is only that E2E readiness correction. Production
  calendar files are identical across all three synchronized review branches.
- Architecture and exact index secret gates passed; syntax tree
  `200429b5eac4fc549210b9fec55132f614d1f2ac` passed 485 source checks.

Windows GPU exit 34 warnings remain. This does not prove hardware acceleration, signed packages,
full Windows unit acceptance or live-school behavior. No new package was built or installed in
this preservation phase. The installed Mac ASAR remained
`705d83f90356cf3b1973d723f4d785765cba4adbba53843394d32c5a013baf0c`.

Rollback must retain the behavior from #106 rather than resurrect its superseded state-only
loading view. Revert module extraction as a unit to the updated parent if needed; no user-data
migration is involved. Native feature registry/lifecycle and remaining governance goals stay open.
