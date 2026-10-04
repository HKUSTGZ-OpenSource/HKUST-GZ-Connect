# Context-bound diagnostic access

- Status: Proposed bounded Diagnostics extraction/hardening for M3; not full goal completion
- Owner: Desktop Diagnostics maintainers
- Last verified: 2026-10-04 (local source and synthetic native checks)
- Applies to: Main diagnostic read/open callbacks and existing bounded log-tail reader

The existing `log-writer.js` public entrypoint owns `DiagnosticLogAccessRuntime`.
Main supplies the fixed log path, current writer, opaque active-context lease,
quit observation, error reporter and narrow OS opener. Construction performs no
IO. The owner captures writer/context before flush and rechecks identity, writer
closed state, context validity and quit state after awaiting. Main only delegates
the existing get-logs/open-log capabilities; no Renderer-selected path is accepted.

Live behavior keeps flush-before-read/open, existing error reporting and advisory
OS-opening rejection handling. Live flush failure may still read the old tail;
retired failures cannot notify another context. A stale read returns an empty
string, stale opening no value/action, preserving IPC types. A reader already
started is awaited and its result/failure fenced at completion, not detached.

The existing bounded `readLogTail` gains optional lifecycle admission (default
true for existing callers). It rechecks before open/content chunks and after
awaited IO/path verification; retirement returns no bytes while descriptor cleanup
still runs in finally. Operations already begun while live cannot be retroactively
undone; no new content read begins after an observed retired boundary. Existing
no-follow checks, bounds, permissions, redaction/retention/rotation and schemas
are not broadened. BufferedLogWriter's body is unchanged.

Main falls 666 to 665 lines with its cap lowered; direct/effective/transitive
metrics remain 20/35/170, private-edge cap 98. No new production module, dependency,
barrel, generic IPC, credential, system-network or installed-app change. The owner
imports neither Profile nor Browser internals; lifecycle/source/opening remain
narrow injected public capabilities.

Seven initial owner tests fail before the owner exists then pass for construction,
live return/order, quit/context/writer retirement during flush, late tail result,
live versus retired failures, inactive sources and advisory opening. Additional
tail failure and actual synthetic-file retirement/descriptor-close cases pass.
Native Main retains previous assertions, reads through real get-logs IPC, then
parks read/open flushes until actual quit proves no later tail/open effects; its
OS opener is test-only, never launched. Windows-selected integration uses Main's
actual constructor options, real opaque lease and private synthetic tail to prove
live reading and invalidation. These are not real user logs or Gateway evidence.

Rollback owner/Main/reader guards/tests/doc and downward budget together; no
stored-data migration. Rollback restores the previously observed post-retirement
diagnostic action risk. Published 2.0.3 is not silently changed. Final Main semantic
and public-entrypoint acceptance remains a separate audit; M1/M2/M5/governance and
original reporter outcomes are not closed by this bounded change.
