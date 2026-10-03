# Desktop proxy-access composition boundary

- Status: Proposed bounded M3/M5 ownership convergence; not a release or complete Main composition
- Owner: Desktop Persistence maintainers
- Last verified: 2026-10-03
- Applies to: candidate based on development `main@803ed1937400349b9edac140419aacaed3346f92`

The existing Persistence public runtime constructs the unchanged encrypted
`ExternalProxyCredentialStore` and `ProxyAccessCoordinator` together. Main injects
the same store options, current Profile accessor and private sidecar write effect;
it no longer imports the two internal credential modules. The Engine-close callback
uses the existing generation-bound cleanup function through that same entrypoint.
There is no new policy implementation, credential authority or generic IPC API.

Store creation remains effect-free. Stable encrypted credentials are reused rather
than regenerated after owner reconstruction. Existing per-Engine copies keep their
generation/port binding and zeroization; the same exact loopback Basic challenge
rules apply. Typed protected-store failure still produces neither an active owner
nor sidecar. Stale Engine close clears only its memory generation and never removes
a newer sidecar. Switch revocation and quit retain their original cleanup behavior.

Six public composition contracts initially fail because the entrypoint is absent,
then pass. Together with existing store/coordinator and Main contract coverage,
32 cases pass. This includes actual synthetic private-file persistence on the local
platform, original owner type, no constructor I/O, reuse/zeroization, Profile and
challenge scope, failure/no-publication, stale cleanup and redacted diagnostics.
Simulated Windows assertions are not native Windows acceptance; exact-head native
private-file/platform/package CI remains mandatory.

Main falls from 776 to 767 lines and 26 to 24 direct dependencies, with 170
transitive modules unchanged and no new production file. Exactly two obsolete Main
private-import exceptions retire; the frozen inventory/ceiling drop 110 -> 108.
The intermediate below-800/24 stage is reached by these measured candidate values,
not the final 500-700/20 composition outcome. M3 and full M5 remain open.

No changed encryption format, persistent schema, credential migration, default
proxy authentication, Engine wire, Renderer, installed application or global network.
Rollback the factory, Main wiring, test seam and reduced debt inventory together;
all original store/coordinator/cleanup APIs are retained.
