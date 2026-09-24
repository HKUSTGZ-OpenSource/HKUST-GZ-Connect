# Official favorites module boundary

- Status: Proposed review candidate; not merged to main, installed or released
- Owner: Desktop Renderer maintainers
- Last verified: 2026-09-10
- Applies to: Issue #79, structural follow-up to PR #108 at `649397b6df436624b0db90463b00807987550a86`

## Public contract

`renderer/features/official-favorites/index.mjs` exports `create` and `comparableUrl`.
The application imports the factory explicitly instead of looking up a Window factory or relying
on the old global script tag. The existing dialog IDs and shared styles remain unchanged.
The dialog element can still be available through the browser's named-element behavior; it is
not a feature factory and application code does not use that mechanism.

`create` receives the bounded favorite APIs, document, translation, resource/group readers and
setters, saved callback and toast callback. Its returned `isFavorite`, `open` and `start` API is
unchanged. Existing-folder, ungrouped and new-folder saves retain the group/resource/move sequence,
localized payloads, validation, busy state and failure display. URL comparison removes fragments;
it is an identity helper, not navigation authorization.

The implementation body is identical to the base after removing the global wrapper, indentation
and adding ES export syntax. No IPC, account/workspace state, routing, storage schema or dependency
changes are part of this extraction. The module map records the public entrypoint.

## Limits and review order

This is one feature extraction, stacked on PR #108 above published 2.0.2; PR #106 is already merged. Review the diff
against its parent branch; revalidate a changed parent before landing it. No GitHub PR merge or
release is authorized by the local tests.

This does not add cancellation, disposal, a shared feature registry or new asynchronous ownership
guarantees. The existing revision checks and pending-operation behavior are retained, not declared
fully audited. Lifecycle changes and remaining Renderer globals require independently reviewed work.
Revert the extraction to restore the previous script factory without changing saved favorites or
the parent's calendar/category repairs. Evidence is in the dated acceptance receipt under archives.

Run packaged-renderer acceptance through `npm run test:renderer-asar` (Node parent). The parent
creates the isolated staging/profile directory and removes it only after Electron closes, checking
directory identity and cleanup completion. Direct execution of the Electron child is rejected;
callers must not bypass the parent and infer success from an early loader message.
