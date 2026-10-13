# Browser persistent Session ownership

- Status: Proposed M2 lifecycle repair; exact-source/native/platform acceptance required
- Owner: Desktop maintainers; accountable maintainer heeh02
- Last verified: 2026-10-13
- Applies to: the Session repair against `main@1aa2a598e4cf937d4d8d259aa05e0e30c1219572`, not a released or installed application

## Problem and contract

Chromium preserves a Session across Browser runtime replacement. A per-runtime operation chain
and intent counter cannot alone protect that shared native object. Offline regressions show that
its request hook can keep the retired readiness callback and that a delayed old PAC write can
overwrite the current runtime's proxy while its displayed port remains unchanged.

The existing per-Session WeakMap is the single shared boundary record. It holds one installed
request hook, current readiness binding, admission epoch, current transition owner and native
operation chain. Each `BrowserSessionManager` binds at most once; losing that binding or explicit
retirement prevents it from reacquiring another runtime's Session authority. No identifier or
new state is persisted, and Profile/Account/Workspace partitions remain unchanged.

- Adoption closes admission synchronously and invalidates queued/in-flight request completions.
- A queued readiness check validates its captured epoch before invoking its captured callback;
  it cannot invoke a replacement callback on behalf of a retired request.
- Read-only PAC preparation remains outside the shared native I/O chain. A retired slow read
  cannot stall a replacement runtime and its eventual result cannot enqueue native effects.
- Already-issued `setProxy`, reload and connection-drain effects settle before the replacement
  writes its PAC. The shared chain prevents a late old native write from winning.
- Every awaited continuation rechecks local intent and shared Session ownership. Stale configure,
  suspend and resume are inert; a failed current replacement stays fail-closed.
- Window context retirement invokes the Session owner's synchronous retirement before close
  confirmation. Ordinary successful window close does not retire the reusable Session owner.
- Repeated retirement is idempotent and cannot block the new owner. Cookies, storage, permission
  denial, shared campus/direct Session identity and native MFA opener relationships are preserved.

`CampusBrowser` composes the retirement port; Window Owner retains native window lifetime;
Session Manager retains PAC/request authority. No parallel policy enters Main, IPC or Renderer.
There is no system proxy/DNS/TUN/route effect, new listener, credential store, schema or dependency.

## Evidence and rollback

The six replacement/readiness/PAC regressions failed against the base. A separate delayed-policy
preparation regression exposed a candidate that serialized too much work; the lock now covers
native effects only. Compatibility controls cover invalid close options, ordinary reuse, distinct
Sessions, failed replacement and explicit retirement. Native evidence must use an isolated Session,
intercepted synthetic origin and synthetic cookie, never a user session or Gateway.

Full Desktop, actual Browser/Main/MFA/strict proxy, exact-tree safety gates and all three platform
package jobs remain acceptance prerequisites. Passing numerical owner ceilings or these bounded
repairs does not complete #80/M2 or the full goal.

Rollback the Session boundary, retirement port, regressions/native fixture and this contract
together. No data migration is needed; rollback can restore the reproduced stale-authority risks.
