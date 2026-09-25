# Desktop test ownership

- Inherit the repository and Desktop `AGENTS.md` contracts.
- Tests do not live directly under `desktop/test/`. Root-file debt is zero and
  `.github/scripts/desktop-root-test-debt.json` must remain empty. Do not restore old exceptions
  or raise the zero cap to introduce a new root test or helper.
- Mirror production ownership: `lib/<domain>/...` tests belong in `test/unit/<domain>/...`;
  Renderer feature/component tests belong in `test/unit/renderer/...`. Cross-owner and repository
  contracts belong in `test/contracts/`, multi-owner integration tests in `test/integrations/`,
  and actual Electron/window interaction fixtures in `desktop/e2e/`.
- A test move preserves assertions and fixtures. Update source-relative imports and external
  references, compare the discovered test set before/after, and run both the moved suite and
  `npm test`. Keep behavior corrections in a separately reviewable change.
- Inject time, filesystem, network and UI effects through the production owner seam. Do not
  create another implementation of production rules merely to make the test pass.
- Use synthetic data. Never copy real credentials, OTPs, cookies, tokens, student records or
  installed application state into fixtures or logs.
- New platform-limited tests declare their skip conditions. Report skipped cases as unverified,
  not passed. Source tests, portable tests, real Electron fixtures and signed/package evidence
  remain distinct claims.
- Keep local-first validation and Actions-budget constraints from the parent contract. Test moves
  do not authorize workflow changes, remote runs, merging, releases or installed-App replacement.
