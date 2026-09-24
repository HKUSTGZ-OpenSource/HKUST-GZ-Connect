# Renderer static boundary policy

- Status: Static boundary policy merged in #110; not a runtime sandbox or release
- Owner: Architecture and Desktop maintainers; policy changes require independent review
- Last verified locally: 2026-09-25
- Applies to: Renderer JavaScript, the two explicitly shared browser helpers and static Renderer HTML

## Enforcement

`npm run check:architecture` now consumes `desktop/scripts/renderer-feature-registry.json`.
The initial reviewed-source snapshot names 31 legacy owners and 109 exports/top-level bindings,
one application bootstrap, and the campus-data/official-favorites native feature entrypoints.
Exceptions are existing migration debt: remove retired names/files and do not expand the list
just to make new code pass. An instruction file is not a substitute for reviewing policy changes.

Acorn 8.18.0 parses source without executing it. The bounded analysis follows supported lexical,
UMD, return-value and reflective-writer aliases; distinguishes shadowed local names; reads literal
module imports/re-exports; and rejects detected dynamic global writes/code paths it cannot approve.
Native owners may not read unbound browser DOM/network globals. Their dependencies must be explicit
and peer imports must use approved public entrypoints. Undeclared sources, API drift, stale global
exceptions and import cycles fail the existing architecture command.

Static HTML script tags may point only at registered bootstrap or existing legacy owners.
The inventory discovers Renderer HTML recursively, including new nested pages. Classic and module
entries must agree with source ownership and loading mode. A direct tag for a feature-private module
or an unregistered Main-side helper cannot bypass the import policy. The manifest does not
claim a runtime mount/dispose registry exists: that lifecycle work remains separate.

## Bounds and limitations

- Individual source analysis is bounded to 2 MiB and 64 alias-propagation rounds; parse or
  convergence failure is a gate failure, not successful analysis of zero imports.
- This is a static collaboration guard, not a JavaScript security sandbox or complete whole-program
  proof. Arbitrary reflection, DOM-derived capabilities, generated scripts and every possible alias
  are not modeled. Review still owns capability/behavior correctness and malicious-code detection.
- HTML uses a deliberately restricted repository source grammar, not a general HTML parser: empty
  external script tags, quoted literal relative JS/MJS paths, and optional module or JavaScript MIME
  type. Inline code, duplicate/ambiguous attributes, encoded/query/remote sources, base overrides,
  incomplete tags/comments and mixed modes are rejected rather than interpreted permissively.
- The inventory bounds HTML files to 64, traversal entries to 4096, each page to 2 MiB and scripts
  per page to 256. Symlinks fail closed. The exact-tree syntax gate shares the same source parser
  and accounts for module declarations outside the main page.
- This still does not audit all HTML recovery rules, event-handler attributes, CSP semantics or
  dynamically generated pages/scripts. Those remain review and runtime-security responsibilities.
- Localization ownership, runtime lifecycle, Main/Rust modularization and real-platform/package
  acceptance remain separate requirements. Passing this gate does not imply those are complete.

The parser is a pinned MIT-licensed development dependency, not an application dependency. No
Renderer, Main, IPC, native runtime or workflow implementation changed in this policy contribution.
Existing required GitHub status names are preserved; local runs do not manufacture CI results.

## Contributor workflow

Add a native feature only with one registered owner/public entrypoint and explicit dependency edges.
Use injected bounded APIs rather than reintroducing globals. Update public-export expectations only
as an intentional reviewed contract change. Run the architecture command plus
`node --test test/unit/renderer/renderer-boundary-gate.test.js` from `desktop/`.

This contribution builds on merged PR #109 and remains independently reviewable from the runtime
extractions. Reverting the policy commit removes enforcement and the dev-only parser dependency;
it must not undo the parent's application fixes or saved user data.
