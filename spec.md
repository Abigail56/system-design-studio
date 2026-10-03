---
description: Write an implementation-ready spec for the Nigeria-first last-mile logistics and dispatch OS (project, feature, or bug fix). Produces a spec file only and never implements.
---

You are writing a spec, not code. Do not modify source files. The only file you create is the spec document.

Input from the user: $ARGUMENTS

If $ARGUMENTS is empty, ask what to spec in one line and stop.

## Product context (fixed, do not re-debate)

This repo is a multi-tenant Last-mile Logistics and Dispatch Operating System for Nigeria (Lagos first, then Abuja, Kano, Ibadan; designed for African expansion). It is a control plane, not a consumer delivery marketplace. It turns an order from any channel into a dispatchable job, assigns it to owned, contracted, or partner fleets, runs offline-first driver execution, and closes the loop with ETA, proof, COD reconciliation, and SLA analytics.

Users: merchants (SME retail, social commerce, pharmacies, restaurants), dispatchers, drivers, recipients, finance staff, courier/3PL operators, platform admins.

The master spec is `specs/project-nigeria-last-mile-dispatch-os.md`. Read it before writing any feature or bug spec. Every feature spec must stay consistent with it. If a request conflicts with it, say so in the spec and recommend whether to change the request or the master spec. Never silently diverge.

### Stack (as decided in the master spec)

TypeScript modular monolith (API app plus worker), PostgreSQL with PostGIS, Redis, BullMQ, transactional outbox, Next.js ops console and tracking page, React Native Android driver app with encrypted SQLite, S3-compatible object storage, OIDC with MFA for operators, short-lived JWT for drivers, adapters for maps, SMS, WhatsApp, and payments. If the repo contradicts this, trust the repo and flag the difference.

Modules: tenancy, orders, location, dispatch, driver-sync, notifications, settlement, reporting, audit.

### Domain invariants every spec must respect

1. Tenancy: every tenant-owned table has `tenant_id` and Postgres row-level security. Every new table or endpoint needs a cross-tenant test.
2. Idempotency: mutating endpoints accept `Idempotency-Key`. Driver events carry `client_event_id` and are applied exactly once.
3. State machines: order and stop transitions are explicit allow-lists. Invalid transitions return `409 invalid_transition`. Failed attempts require a reason code from the fixed enum.
4. Original data is never overwritten: location corrections create a new `location` row linked by `supersedes_id`.
5. Outbox: a state change and its outbox row commit in one transaction. Consumers are idempotent by `event_id`.
6. Offline-first driver app: every driver-facing change must state its offline behavior, sync behavior, conflict handling, and low-bandwidth payload size.
7. Money: integer kobo plus currency. COD amount is locked at delivery unless an exception reason is given. The platform never holds customer funds and never provides escrow or regulated payment services. Settlement is record-keeping and import-based.
8. Providers: maps, SMS, WhatsApp, and payments are only reached through adapter interfaces with timeout, retry with backoff, and a circuit breaker. A fallback or manual mode must be specified.
9. Privacy: Nigeria Data Protection Act 2023 applies. Minimize PII, mask driver and customer contact, redact logs, define retention. Tracking links are tokenized and expose no full address or driver phone.
10. Audit: state changes, corrections, overrides, and support access to unredacted data write to the append-only `audit_event` table.
11. Observability: each feature names its metrics, log fields (`request_id`, `tenant_id`, `order_id`, `job_id`), and alerts.

## 1. Classify

Decide the type:

- Project: new system or major subsystem (rare here, the master spec already covers the product)
- Feature: new capability, such as a connector, optimizer, new proof type, or payout rule
- Bug fix: existing behavior is wrong

If unclear, state your best guess in one line and continue.

## 2. Investigate before asking

Read the repo first. Find the files, modules, migrations, and conventions the work touches, and any code that already solves part of it. Check `specs/` for related specs.

For bugs: find the failing path, run `git log` on the relevant files, and reproduce it. Record the exact command and output. If it involves tenancy, sync, or reconciliation, check whether the same flaw exists elsewhere.

If the repo is empty, work from the master spec and mark assumptions.

Never ask a question the repo or the master spec can answer.

## 3. Clarify

Ask only what blocks a correct spec. Maximum 5 questions, numbered, each with a recommended default so the answer can be "go with defaults". If nothing blocks you, skip this step and list assumptions in the spec.

## 4. Write the spec

Save to `specs/<type>-<kebab-slug>.md` (`project`, `feature`, or `bug`). Create `specs/` if missing. Use the matching template. Be specific: real file paths, function names, endpoints, field names, and numbers.

### Project template

```
# Project: <name>

## Purpose and Users
## Scope (in scope v1, out of scope)
## Architecture
## Tech Stack
## Data Model
## API Surface
## Milestones (each with a runnable done condition, each independently shippable)
## Risks
## Testing and Observability
## Deployment
## Open Questions and Assumptions
```

### Feature template

```
# Feature: <name>

## Summary
What it does and why, 3 sentences or fewer. Name the user role it serves.

## Requirements
Numbered, each testable. Must-have and nice-to-have.

## Current State
Existing files, modules, and patterns touched, with real paths.

## Design
Changes per file or module: new files, changed functions, types, endpoints, schema changes with migration plan.

## Impact Checklist
For each, write the specific impact or "none, because <reason>":
- Tenancy and RLS
- Order or stop state machine changes
- Idempotency and outbox events (new event types, webhook payloads)
- Driver app and offline sync (offline behavior, conflict handling, payload size)
- Provider adapters (which, fallback, circuit breaker)
- COD, settlement, and payout math
- Privacy and NDPA (new PII, retention, masking)
- Audit events
- Notifications and templates

## Edge Cases and Failure Modes
Each with expected behavior. Always consider: duplicate request, out-of-order event, provider outage, recipient unreachable, device offline for hours, clock skew.

## Testing
Tests by file and name, plus the commands to run them. Include a cross-tenant test where data is tenant-owned. Use provider sandboxes, not mocks.

## Observability
Metrics, log fields, alerts.

## Rollout
Feature flag, migration order (expand, migrate, contract), backwards compatibility, rollback.

## Out of Scope

## Open Questions and Assumptions
```

### Bug fix template

```
# Bug: <short title>

## Symptom
What happens, what should happen, who is affected, tenant scope. Exact reproduction command and the output observed when you ran it.

## Root Cause
Failing path with file paths and line references. Evidence: logs, commits from git log, or a failing test. If unconfirmed, say "unconfirmed" and list hypotheses with how to test each.

## Data Impact
Rows already corrupted or duplicated (orders, stops, COD records, payouts, notifications), how to detect them with a query, and the repair plan. State whether any money figures are affected.

## Fix
Exact changes per file. Smallest change that fixes the root cause.

## Regression Test
The failing test to add first, by file and name, and the command that runs it. For tenancy, sync, or reconciliation bugs, include an invariant or property test.

## Risk and Side Effects
What else touches the changed code. What could break.

## Verification
Steps to confirm, including rerunning the reproduction.

## Open Questions and Assumptions
```

## 5. Finish

After saving, reply with exactly:

1. The spec file path
2. A summary of 3 to 5 lines
3. Assumptions the user should confirm
4. Suggested next step (for example, "implement milestone 1")

Then stop. Do not start implementing. Wait for approval.

## Rules

- Spec against the actual repo, never in the abstract.
- Smallest design that meets the goal. Call out scope creep. Items the master spec marks out of scope (owning fleet, holding funds, consumer marketplace, iOS, other countries) stay out unless the user explicitly changes that.
- Every requirement is testable. If it cannot be verified, rewrite it.
- Mark unknowns as unknown. Do not invent file names, APIs, or behavior you did not verify by reading the code.
- No mocks or placeholders. Tests hit real services or provider sandboxes, and the spec names them.
- No hardcoded secrets. Specify env vars or a secret store.
- No in-memory state for anything that must persist.
- Nothing is marked verified unless you ran it.
- Write directly. No marketing language, no padding, no em dashes.
