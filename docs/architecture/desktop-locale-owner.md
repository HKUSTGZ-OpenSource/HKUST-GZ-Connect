# Desktop locale ownership

- Status: Proposed bounded Platform extraction for M3; not full M1/M3/M5 completion
- Owner: Desktop Platform maintainers
- Last verified: 2026-10-04 (local source/native checks; exact-head CI in the PR)
- Applies to: existing Main-process i18n module and Main presentation bindings

The existing i18n file now owns Desktop locale and translator identity in
`DesktopLocaleRuntime`. It reuses the unchanged dictionaries, `createT`,
`effectiveLocale` and `resolveLocale` rather than introducing another language
policy. Construction performs no settings/OS/UI effect and retains Chinese as
the pre-ready fallback. Current selection reads saved settings before the OS,
including the original OS read for explicit saved choices. Fallback only reads
the OS. Read failures preserve their cause and App startup still owns recovery.

Startup set publishes its chosen value without additional reads. User choice
resolves through the original primitive, then replaces the actual translator
function just as before. An old captured translator continues to use its original
dictionary. Main's immediate translation adapter reads the current owner, while
injected Engine/Browser getters return the actual function, not that adapter.
No extra save, initialization event or new locale validation changes behavior.

Main retains only the existing injected presentation order: choose language,
refresh application menu, update Browser locale/translator, then emit status.
The owner does not own Browser lifecycle or import another domain. Settings,
Profile/Account/Workspace, authentication, routing, timers and Renderer/preload
contracts are unchanged. Both translation dictionaries and all original selection/
interpolation functions are byte-identical to the base.

The existing file is declared a **file-level** Platform public entrypoint for its
three actual consumers (Main, Browser and Engine-output). All existing exports,
including dictionaries and primitives, are publicly importable at that level;
the map does not pretend to enforce a curated symbol list. Three exact old private
edge exceptions retire; inventory/hard cap falls 101 -> 98. No module, dependency,
barrel or production graph edge is added. Full dynamic Renderer/Rust/M5 enforcement
remains incomplete and `dependencyEnforcement: inventory-only` stays unchanged.

Baseline localization/startup contracts pass. Six new owner cases fail before
the class exists, then pass for fallback/read order, current values, function
identity, same-language rebuilds, failure propagation and invalid construction.
Main source contract retains effect order; native Main/Browser toggle en/zh through
the existing save IPC and observe both DOM locales. Layout/focus/keyboard/overflow/
reduced-motion fixtures remain separate acceptance evidence. Main falls 674 -> 669
lines with direct/effective/transitive metrics 20/35/170 unchanged; cap ratchets down.
Remaining M3 recovery-notice/resource-feed authority still needs semantic review.

Rollback owner and Main bindings, public declaration, exact retired edges, tests
and downward budgets together. Original primitives remain exported. No migration,
installed app, system network, release or live-school operation is involved.
