# Shared portal credential ownership

- Status: Proposed bounded Profile policy extraction for M3; not full M3/M5 completion
- Owner: Desktop Profile maintainers
- Last verified: 2026-10-04 (local source and synthetic native checks)
- Applies to: existing Main-only shared connection credential selection for the reviewed primary portal

The existing Profile runtime entrypoint now owns the shared-portal admission
predicate in `createSharedPortalCredentialProvider`. Main supplies a current
Profile-ID reader and its unchanged persistent disposable-credential opener;
Browser consumes the returned callback through the unchanged option. There is
no import of Persistence/Browser internals by the new policy and no new module.

Construction validates function capabilities without reading context or opening
credentials. The original exact sequence remains: compare origin strictly with
the reviewed SSO origin, read current Profile ID only when it matches, compare
strictly with the trusted primary ID, then delegate the credential open or return
null. No normalization, alias, fallback, captured identity, additional secret read,
owner inspection, serialization or new entitlement is introduced. Context/open
failures preserve identity. Custom/unknown Profiles are still denied even at the
same origin. The underlying persistent opener and returned owner remain unchanged;
the policy does not consume or destroy that owner or acquire staged-memory access.

Main's deployment-specific credential-origin gate count falls from one to zero.
The source contract freezes that zero rather than deleting unrelated code solely
to improve line count. Main remains 666 lines, 20 direct/35 effective/170 transitive
dependencies and private-edge cap 98; no size/import/fanout budget grows. This is
semantic policy ownership, not a claim that dependency/line metrics fell. Existing
controller bodies and Profile/Account/Workspace paths, schemas, entropy, capability
reporting, authentication and presentation are unchanged.

Four new owner tests fail before the factory exists, then pass for effect-free
construction, exact origin/Profile rejection, short-circuit/no coercion, current
identity, unchanged owner/failure identity and no inspection. Native Main captures
the actual factory and proves rejected origins do not read Profile/open credentials,
while the exact primary origin delegates its existing no-credential path. The
existing Windows-selected integration evaluates Main's actual wiring using the
public disposable owner and confirms caller-owned consumption/destruction. Those
synthetic/platform checks are not a real password, cookie, SSO or Gateway canary.

No Preload/IPC/Renderer export, persisted schema, credential, TLS, route, system
network or installed-app change. Rollback factory/Main/contracts/fixtures together
needs no migration and restores the same admission predicate to Main. Published
2.0.3 is unchanged. Final Main semantic/public-entrypoint review and full M1/M2/M5/
governance/report outcomes still need independent acceptance before goal closure.

## Follow-on: reviewed portal data availability

The same existing Profile controller exposes `portalDataSources(sources)` for
the maintained campus-data adapters injected by Main. It selects by the exact
normalized Profile ID already owned by this controller: reviewed primary returns
the supplied source map unchanged; other Profiles receive a fresh empty object
on every call. It neither inspects/fetches adapters nor opens credentials, sessions
or storage. No new Profile field, service discovery or custom-school capability
is added. The Browser data runtime still owns all request/cache/context lifecycle.

Main now delegates its data getter to this public Profile capability rather than
comparing the deployment ID itself. The one remaining literal primary-ID gate in
Main falls to zero, frozen by a source contract. Current Main is 662 lines with
20 direct/35 effective/170 transitive dependencies and private-edge cap98;
none of these numeric budgets grows. The earlier 666-line credential slice above
is historical; the follow-on's debt reduction is policy ownership, not line count.
All other controller/factory/credential bodies are byte-identical.

Local red-to-green contracts cover exact map identity without inspection, real
candidate-backed primary/custom Profiles and fresh empty rejection. Native Main
primary/custom startup captures its actual data getter; Windows-selected integration
uses Main's actual callback and real controllers/provisioned private custom scope.
These calls perform no data fetch or real-school test; native Windows and packages
remain separately required. Existing origin/credential policy is not broadened.

Rollback this method/Main callback/contracts/fixtures together needs no stored
migration. Main's full semantic/public-entrypoint exit audit remains required for
#81, independently of M1/M2/M5/governance/report and full-goal completion.
