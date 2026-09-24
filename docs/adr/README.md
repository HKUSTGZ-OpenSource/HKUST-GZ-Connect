# Architecture decision index

- Current implementation status: [`../2.0-status.md`](../2.0-status.md)
- Current indexed implementation baseline: stable `v2.0.0` at
  `415a3b5dfb9d11bffa14cde27e924af486823249`
- Decision owner: project maintainer unless an ADR states otherwise

ADRs record durable or security-relevant decisions. P3/P6 step-level documents are retained as implementation
records for review and recovery evidence; future procedural notes belong under `docs/engineering/`.

| ADR | Title | Status | Kind | Current implementation |
| --- | --- | --- | --- | --- |
| 0001 | TUN mode | Deferred | Product decision | Not active |
| 0002 | Campus Browser direct-route safety | Accepted limitation | Security decision | Current Chromium Direct boundary |
| 0003 | Multi-school profiles and Custom Gateway | Accepted | Product/security decision | P1/P3-P6 |
| 0004 | Profile, Account and Workspace scope | Accepted | Security/ownership decision | P3-P4 |
| 0005 | External Tool Integration Center | Accepted | Product/security decision | P7 |
| 0006 | Production provider composition | Accepted | Protocol architecture | P2 |
| 0007-0015 | P3 storage, receipts, migration and runtime authority | Accepted | Implementation records | P3 |
| 0016 | Generation-bound Gateway connector | Accepted | Security/protocol decision | P5 |
| 0017-0020 | P3 production activation and recovery | Accepted | Implementation records | P3 |
| 0021 | Gateway connector consumption | Accepted | Security/protocol decision | P5 |
| 0022 | Credential-free public Gateway probe | Accepted | Security decision | P6 |
| 0023-0029 | Custom Profile provisioning, startup and switch | Accepted | Implementation records | P6 |
| 0030 | P3 runtime storage path seam | Accepted | Implementation record; renumbered from duplicate 0016 | P3 |
| 0031 | P8 WebResource library and on-demand Campus boundary | Accepted | Product/security decision | Released in 2.0.0 |
| 0032 | Repository-ID-bound update discovery | Accepted | Security/ownership decision | 2.0.1 transfer bridge |
| 0033 | Desktop compatibility proxy default | Accepted | Security/product decision | Post-2.0.0, implementation pending review |

No ADR type, fixture or design text promotes an unsupported provider. Current capability truth remains the
intersection of compiled providers, active Profile policy and runtime evidence.
