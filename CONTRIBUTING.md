# Contributing to HKUST(GZ) Connect

Thank you for helping improve the project. Contributions from people using coding agents are
welcome, but the person opening a pull request remains accountable for its scope, provenance,
validation and security.

## Before starting

1. Read `AGENTS.md`, `ARCHITECTURE.md` and the nearest nested `AGENTS.md`.
2. Search existing issues and pull requests.
3. Open or claim one issue with acceptance criteria and explicit non-goals.
4. Record the exact `origin/main` commit used as the base.
5. Use one isolated worktree and one branch for that issue.

External contributors should use a fork. Direct write, release and administrator permissions are
reserved for trusted maintainers. Do not use a shared maintainer token for an agent.

## Branch and pull-request model

Use one of these forms:

```text
fix/<issue>-<slug>
feat/<issue>-<slug>
refactor/<issue>-<slug>
docs/<issue>-<slug>
security/<issue>-<slug>
ai/<agent>/<issue>-<slug>
```

Pull requests normally target `main` and use squash merge. Stacked pull requests must name their
parent and cannot silently change base branches. A pull request should contain one domain and one
independently reviewable outcome; aim for no more than 300–500 lines of hand-written change unless
the excess is a reviewed move, fixture, localization table or lockfile.

Do not combine GUI redesign, protocol behavior, persistence migration, CI and release changes in
one pull request.

## Development environment

- Node.js 24
- npm with the committed `desktop/package-lock.json`
- Rust installed through `rustup`; the exact toolchain is pinned by
  `independent/rust-toolchain.toml`
- Windows plus WSL for primary development: WSL for shared Linux-side checks, a separate native
  Windows checkout for Windows APIs, UI, private-file helper and NSIS validation
- macOS for macOS-specific changes, native Electron/browser acceptance and local DMG verification
- GitHub Actions retains the required macOS, Windows and Linux package matrix and native test jobs

Start with the [Windows/WSL development handoff](docs/engineering/windows-wsl-handoff.md) for
fresh-clone commands, exact toolchains, current work and the Mac packaging boundary. Keep source
on the filesystem of the tools executing it; never share `node_modules`, Cargo `target`, staged
Engine binaries or package outputs between operating systems. Synchronize through reviewed Git
commits. WSL/WSLg does not establish native Windows acceptance.

Install Desktop dependencies:

```bash
cd desktop
npm ci
```

The Rust commands must be run from `independent/` with the pinned toolchain available.

## Validation matrix

### Documentation only

- Check relative links, current/historical status and authority claims.
- Run the repository-governance contract once it is available.
- Run `git diff --check`.

### Desktop application or domain

```bash
cd desktop
npm test
npm run check:architecture
npm run check:secrets
npm run check:install-scripts
npm run check:syntax
```

Run the relevant Electron E2E for Browser, MFA, Profile, migration, routing, layout, performance or
Engine lifecycle changes.

### Renderer or GUI

- Run affected unit/component tests.
- Run `npm run test:renderer-layout` and/or `npm run test:workspace-layout`.
- Capture narrow, standard and wide layouts for changed surfaces.
- Verify keyboard operation, visible focus, overflow, zoom and reduced motion.

### Rust Engine or protocol

```bash
cd independent
cargo fmt --all -- --check
cargo clippy --locked --all-targets --no-default-features -- -D warnings
cargo test --locked --no-default-features
```

Auth/Control changes also run the synthetic Desktop/Engine fixture. Live-school evidence is a
separate, explicitly authorized gate and is never inferred from offline tests.

### Persistence, credentials or release

- Run upgrade/migration and relaunch tests.
- Run exact-tree secret scanning.
- Require Security/Release owner review.
- Let CI build and verify all supported platform packages from the same commit.

## Security and school data

Never submit:

- usernames, passwords, OTPs, cookies, tokens, private keys or authorization headers;
- raw packet captures, browser profiles or unredacted logs;
- official vendor installers/binaries unless redistribution is explicitly lawful and approved;
- personal student/staff data;
- unsupported claims derived only from a type, mock, fixture or UI placeholder.

Use synthetic fixtures and stable typed failures. See `SECURITY.md` for private reporting.

## AI-assisted contributions

The pull-request template records whether an agent assisted. Include:

- which work was agent-assisted;
- the accountable human/contributor;
- the issue and owned paths;
- tests and evidence actually produced;
- external source/provenance information;
- limitations and unverified assumptions.

Do not attach raw prompts, transcripts or tool logs containing private data. An implementation
agent does not approve or merge its own work. Agent output is reviewed like any other untrusted
contribution.

## Documentation and architecture

- User instructions remain in `README.md`; do not turn it into a changelog.
- Current truth, durable decisions, plans, research and historical evidence have different homes;
  follow `docs/README.md`.
- Difficult-to-reverse ownership, wire, persistence or security decisions require an ADR.
- Never increase an architecture or performance budget merely to make a change pass.

## Definition of done

A pull request is ready only when it records:

- base and final commit;
- issue and acceptance criteria;
- changed/owned paths;
- user-visible behavior;
- security, privacy, migration and compatibility impact;
- tests run and their results;
- tests not run and the reason;
- screenshots where relevant;
- rollback or safe failure behavior;
- remaining risks and follow-up work.
