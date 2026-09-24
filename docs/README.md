# Documentation map

- Status: Current index
- Owner: project maintainers
- Last verified: 2026-09-04
- Applies to: `main` and the latest stable release

This index defines where project truth lives. Documents describe evidence and decisions; they do
not authorize releases, real-school testing or access to credentials.

## Authority order

When statements conflict, use this order:

1. the published stable release and its exact immutable tag;
2. source and current-state documents on `main` at the same commit;
3. accepted ADRs and versioned protocol specifications;
4. the product roadmap;
5. proposed designs and execution plans;
6. historical audits, implementation records and local worktrees.

A local or uncommitted worktree is never public project authority.

## Maintained documentation

| Location | Purpose | Must not claim |
| --- | --- | --- |
| `../README.md` | Installation, ordinary usage, privacy and troubleshooting | Internal history or speculative capability |
| `../ARCHITECTURE.md` | Normative cross-component safety and dependency boundaries | A temporary implementation sequence |
| `../GOAL.md` | Active repository-governance objective and completion gates | Runtime capability by itself |
| `../CONTRIBUTING.md` | Human/agent contribution workflow and validation | Maintainer or release authorization |
| `../SECURITY.md` | Private vulnerability-reporting policy | The complete internal threat model |
| `2.0-status.md` | Short current implementation and support statement | Historical beta evidence as current truth |
| `product/` | Current product contracts and user outcomes | Unverified school/protocol support |
| `architecture/` | Target architecture, module map and modularization plan | Current completion without status evidence |
| `adr/` | Durable, difficult-to-reverse decisions | Step-by-step implementation notes |
| `governance/` | Branch, release, ownership and collaboration rules | Source behavior that is not enforced |
| `engineering/` | Maintained build/test/release engineering guidance | Raw protocol evidence |
| `research/` | Sanitized observations and reproducible research workflows | Secrets, raw captures or vendor redistribution |

## Historical documentation

`audits/` and `plans/` contain dated evidence and implementation ledgers. They are not current
authority unless a maintained index explicitly promotes one statement. New historical material
should go under `archive/` with its original date, scope and superseding document.

Tool- or agent-specific directory names are not canonical project categories. Raw prompts,
transcripts and private tool outputs are not project documentation.

## Required document header

New maintained documents declare:

```text
Status: Current | Accepted | Proposed | Historical | Superseded
Owner: person or team
Last verified: YYYY-MM-DD
Applies to: paths, versions or commits
Supersedes / Superseded by: when relevant
```

Do not embed an active feature-branch name, an uncommitted worktree or a mutable CI result in a
durable contract. Release receipts may use exact tags, commits, workflow runs and artifact digests.

## Current key documents

- Current implementation: `2.0-status.md`
- Product definition: `product/2.0-product-definition.md`
- Machine-readable module ownership (path/entrypoint subset enforced): `architecture/module-map.yml`
- Module-map coverage scope and limits: [schema 2 contract](architecture/module-map-enforcement.md)
- Modularization plan: `architecture/modularization-plan.md`
- Collaboration model: `governance/collaboration-model.md`
- Main protection: `governance/main-branch-protection.md`
- Current governance activation: `governance/2026-09-04-governance-activation.md`
- Machine-readable GitHub settings: `governance/repository-governance-contract.json`
- Organization transfer procedure: `governance/repository-transfer-playbook.md`
- Data classification: `security/data-classification.md`
- ADR index: `adr/README.md`
