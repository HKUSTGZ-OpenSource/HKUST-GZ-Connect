# Responsive category release-line follow-up

- Status: Historical source validation; not release authority
- Owner: Desktop/UI maintainers
- Verified: 2026-09-08
- Applies to: PR #106; separate from the structural PR #108
- Base: `48140fd189b073af28dc4f6f24430b116ff0a22c`
- Test correction: `50fd32a`
- Behavior repair: `6bd8e6fcc4f8545e6bd250417414eefcfcc0e13a`
- Tested tree: `d083657a93596affdc741d5823c0ec56270e56d5`

## Evidence and changes

The control-shell fixture required five cards on the first page at every width. The shipped
candidate's wide projection intentionally unfolds automatic decks while retaining manual decks,
so that fixture's first wide page contains three cards in two slots. The corrected test explicitly
checks both responsive modes, enumerates every wide page, compares the exact six placement IDs
with the saved document, and proves browsing does not rewrite the layout. The full Mac shell
fixture then passed, rather than skipping the formerly failing assertion.

An extended six-category fixture also exposed a genuine keyboard bug: wide pagination replaced
the focused control without restoring focus (`undefined !== '0'`). Source review identified that
focusCard resolved the saved deck ID rather than the current visible placement projection.
The existing reviewed local candidate repair was adopted narrowly: reveal by placement identity,
retain the selected category across resizing, use service-style motion and restore pager focus.
Filtered categories return false instead of claiming successful focus. Manual decks are unchanged.

Only the shared Card Board controller and two Electron fixtures changed. No Main, IPC, native code,
profile/account/session, storage schema, saved category ordering or network policy changed.

## Actual checks

- Mac Node 24.19.0 Card Board/controller/view/motion/category tests: 26 passed.
- Native Windows Node 24.20.0 on 5070 via RBMS SSH: the same 26 passed.
- 5070 Linux full Desktop suite, exact Git commit, umask 022: 1269 passed, 6 platform skips,
  0 failures.
- Mac real Electron: full control-shell, expanded category fixture, schedule-navigation,
  resource-manager and campus-workspace fixtures passed.
- Native Windows real Electron: expanded category and full control-shell fixtures passed.
  Chromium logged a GPU-process exit warning (code 34) in each invocation; this is not evidence
  of clean hardware-accelerated rendering.
- Architecture, install-script, governance, staged secret scan and exact-code syntax: passed.

The category fixture covers later-page reveal, pager keyboard focus, service animation, repeated
wide/narrow transitions, manual decks and saved-document stability. It asserts the target card is
actually visible, not merely that the focus method returns true. One exploratory Mac run stopped
earlier at the existing dialog-open assertion; two subsequent complete runs passed. That intermittent
timing result is retained as an unresolved test-stability risk, not hidden by increasing timeouts.

## Release and rollback boundary

## Dialog redraw follow-up (2026-09-08)

- Runtime: `8d6109a7ec2811ff9df96c87f47bdc58dcf495b4`.
- Tested tree: `0b345957a7b5460ab288c604426ea82a176b93fd`.

A deterministic regression opens category details and calls the controller's render method.
Before the repair, replacing the board's innerHTML detached the open dialog. The exploratory
failure used a Renderer-thrown assertion; this was subsequently changed to explicit Node assertions
for connected/open/focus state to make future failures diagnosable. This establishes a real redraw
defect, but does not prove every earlier intermittent dialog failure had the same event sequence.

Rendering now replaces only card-projection children while leaving an open modal continuously
connected to the top layer. It retains existing event delegation and keyboard focus; it does not
detach/reinsert the dialog or mount it under a different event owner. Data changes, replacement
layout documents, loaded layout authority, edit entry and destruction still retire the old dialog.
No timeout, animation budget, settings, persistent schema, IPC or network behavior was changed.

The final Electron fixture verifies redraw survival at every tested width, actual cross-breakpoint
resize with an open dialog, focus retention and retirement after data/layout changes. Mac and native
Windows category and full control-shell fixtures pass. Mac focused Node tests: 26 pass; 5070 Linux
full Desktop suite: 1269 pass / 6 platform skips / 0 fail. Architecture, install-script, governance,
staged secret and exact-code syntax gates pass. Native Windows still logs GPU process warnings
(exit 34, plus invalid GPU-state messages); hardware acceleration remains unverified.

## Updated package boundary

The previously prepared four 2.0.2 installers and their old receipts do **not** contain this runtime
repair. They must not be published as evidence for this updated source. New exact-source package
acceptance is required when the release path is authorized. No package was rebuilt, installed or
published here; the user's installed app and data remain untouched.

PR #108 depends on the earlier #106 head. It remains a draft and must consume/revalidate this new
base before its pure structural diff is merge-ready. This phase does not merge either PR, transfer
the repository, change GitHub protections, consume Actions minutes or run a real-school test.

Revert the behavior commit to restore the previous category projection behavior; no user data
migration is needed. Reverting the separate test correction only restores the outdated assertion.
