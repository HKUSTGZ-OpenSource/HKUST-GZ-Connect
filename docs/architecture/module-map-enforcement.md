# Module map coverage contract

- Status: Path-coverage contract for M5; dependency enforcement remains incomplete
- Owner: architecture and repository maintainers
- Last verified: 2026-09-25
- Applies to: `module-map.yml` schema 2 and `desktop/scripts/module-map-coverage.js`
- Scope: path coverage, ownership uniqueness, schema and public-entrypoint existence

## What is enforced

`npm run check:governance` parses the module map as YAML and checks its complete schema, not keyword
counts. Existing workflow/check names and permissions are unchanged. Run this locally before a
remote batch; this document does not authorize Actions usage, merging or release.

Coverage is fixed in the checker, so a map cannot declare a smaller scope to hide missing owners:

- all tracked files under `desktop/lib/`, `desktop/renderer/`, `desktop/assets/`;
- `desktop/main.js`, `desktop/preload.js`, `desktop/campus-preload.js`;
- all tracked files under `independent/src/` and `independent/config/`;
- the root `hkustgzconnect` script and `tools/mac-cli/`.

Every path in those scopes must match exactly one module. Other declared paths, such as docs and
build tooling, are also checked for pattern overlap and stale patterns, but this is not a claim of
complete ownership coverage for every repository document/test/configuration file.

`paths` supports exact repository-relative paths or a terminal `/**` subtree. General globs,
absolute paths, traversal and backslashes are rejected. Overlap is checked at the pattern level,
including overlaps that would only become visible when a future file is added. Each pattern must
match an existing tracked path. Public entrypoints must be tracked files within their declared
owner. Duplicate module IDs/paths, unknown dependency IDs, invalid risk/check fields, extra fields,
YAML duplicate keys, unsafe YAML tags and unsupported schema versions fail closed.

The check uses the Git tracked-path inventory and the current working module-map contents. It does
not replace the separate exact-tree secret/syntax gates or no-symlink governance rules.

## Corrected ownership gaps

The previous map left 26 runtime source/entry paths unowned. Schema 2 assigns the IPC suite to
`desktop-ipc`, application assets to `desktop-assets`, root CLI helpers to `desktop-cli`, shipped
ProxyCommand/Gateway probes to `engine-helpers`, and the non-shipped synthetic auth fixture to
`engine-test-support`. Shared Rust protocol/configuration roots have explicit paths; the existing
`independent/src/lib.rs` public entrypoint now lies inside its owner. Legacy tunnel observation code
is explicitly classified under `compatibility-lab` rather than silently omitted.

These labels do not activate a protocol provider, alter Cargo feature selection, or prove that a
test-support/compatibility module is unreachable from production. Those require the separate Rust
visibility, feature and package gates.

## What remains incomplete

`dependencyEnforcement: inventory-only` is an explicit schema field. This check validates referenced
module IDs but does not prove cross-module dependency direction or prohibit importing a private
file. Do not change the field to claim otherwise. The existing Desktop architecture and Renderer
feature checks cover their separately documented subset; complete M5 import and Rust visibility
enforcement remains outstanding, alongside M2–M4 ownership extraction.

`requiredChecks` records module review requirements; this checker accepts only its closed reviewed
vocabulary of existing GitHub contexts and local acceptance aliases, rejecting typos and invented
names. Adding a new name requires an explicit checker/policy review. It does
not edit GitHub Rulesets or prove the named remote checks ran. A green local coverage check is not
cross-platform packaging or real-school evidence.

## Dependency and rollback

The implementation uses `js-yaml@4.3.2`, already present in the Desktop lockfile, now explicitly
declared as a development dependency. No package version or transitive graph is upgraded. The
installed package metadata declares MIT licensing. Node's standard library has no YAML parser;
using the existing locked parser avoids a partial hand-written YAML interpreter. It is used only
by build/governance scripts and does not become an application runtime dependency.

Rollback the schema/checker/map changes together. There is no user-data migration, runtime logic
change, system-network mutation or installed application replacement. The former textual inventory
checker cannot read schema 2 as equivalent proof of coverage.

The 2026-09-12 candidate and its local test counts are historical evidence, not current acceptance.
The closed required-check vocabulary rejects misspelled names such as `desktpo`, but does not prove
that any named command ran. Current-tree coverage and cross-platform package gates must be rerun.
