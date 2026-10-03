# Project: Ghost AI

## Purpose and Users

Ghost AI is a real-time collaborative system design workspace. Multiple engineers draw architecture diagrams together on a shared canvas (drag-and-drop shapes for databases, services, queues; connect them with edges; see each other's cursors and presence). An AI agent participates in the session: it can generate a system design onto the canvas, answer questions in a chat sidebar, and once the design is complete, write a detailed markdown spec that a dev team can implement.

Success looks like: 3+ users editing the same canvas with sub-100ms sync, the AI producing a coherent diagram from a natural-language prompt in under 60 seconds, and the generated spec being detailed enough for a developer to implement without further clarification.

## Architecture at a glance

Two deployables plus a third for background jobs:

| Deployable | Stack | Host | Responsibility |
|---|---|---|---|
| `frontend/` | Next.js 16 App Router, TypeScript | Vercel | UI, Clerk session, server rendering. No business logic, no database. |
| `backend/` | FastAPI, SQLAlchemy 2.0 async, Alembic | Fly.io or Railway | All HTTP API, all authorization, all database access. |
| `frontend/trigger/` | Trigger.dev tasks, TypeScript | Trigger.dev cloud | Long AI jobs. Claims QUEUED rows from Postgres. |

```
Browser ──► Next.js (Vercel)                Clerk holds the session
             │  Authorization: Bearer <clerk session JWT>
             ▼
          FastAPI (Fly.io) ──► Postgres        verifies JWT, owns all data
             │
             └──► ai_task rows (QUEUED)
                        ▲
                        │ FOR UPDATE SKIP LOCKED
             Trigger.dev worker (cloud)        performs the model call
```

The single most important constraint: **only `backend/` touches the database.** Next.js holds no ORM and issues no queries.

## Scope

### In scope (v1)
- Real-time collaborative canvas with shapes, edges, cursors, and presence
- AI agent that generates designs onto the canvas from natural-language prompts
- AI chat sidebar for asking questions about the design
- AI-generated markdown spec export from the current diagram
- User auth (sign in/sign up)
- Project CRUD and collaborator invites with role-based permissions
- Auto-save with snapshot history stored in Vercel Blob
- Deployment: Vercel for the frontend, Fly.io or Railway for the API

### Out of scope (v1)
- Version history / time-travel on the canvas (snapshots are point-in-time only)
- AI that edits an existing diagram incrementally (v1 AI generates from scratch)
- Comments or annotations on shapes
- Export to PNG/SVG
- Self-hosting
- Mobile-optimized canvas (desktop-first)

## Tech Stack

| Choice | Reason |
|---|---|
| Next.js 16 App Router | User-specified. Server Components render auth-gated pages without shipping auth logic to the browser. `proxy.ts` (Next 16's rename of `middleware.ts`) guards routes. |
| Python + FastAPI | User-specified. Async-native, typed via Pydantic, generates OpenAPI docs. |
| SQLAlchemy 2.0 async + Alembic | Prisma is TypeScript-only, so the Python backend needs its own layer. This is the closest analogue and keeps versioned migrations. |
| Postgres via asyncpg | Single source of truth, shared by the API and the Trigger.dev worker. |
| Clerk | User-specified. JWT session tokens mean the Python service can verify identity without sharing a session store. |
| @xyflow/react (React Flow) | Industry-standard node-based canvas; drag/drop, edges, zoom, minimap out of the box. |
| Liveblocks + Yjs | User-specified. WebSocket sync, presence, cursors, and a Yjs doc that is the real-time source of truth. |
| Trigger.dev | User-specified for long AI jobs. TypeScript-only, which is why the worker is a separate TS service rather than part of the Python API. |
| Vercel AI SDK | Streaming chat and structured output for diagram generation. |
| Vercel Blob | User-specified for snapshots. |
| Tailwind CSS v4 | Already in the scaffold. |

## Data Model

SQLAlchemy models in `backend/app/models.py`. Initial migration `backend/migrations/versions/0001_initial.py`.

| Table | Purpose | Key columns |
|---|---|---|
| `user` | Mirror of a Clerk identity | `clerk_id` unique, `email` indexed |
| `project` | A design workspace | `owner_id` FK cascade, `updated_at` |
| `project_member` | Per-user role on a project | unique `(project_id, user_id)`, `role` enum |
| `project_invite` | Invites for emails with no account yet | unique `(project_id, email)`, `role` |
| `chat_message` | AI and user chat | `role` string, index `(project_id, created_at)` |
| `snapshot` | Index row for a Vercel Blob snapshot | `blob_url`, index `(project_id, created_at)` |
| `ai_task` | AI job queue and result | `type`, `status`, `attempts`, `result` JSONB |
| `rate_limit_bucket` | Fixed-window rate limit counters | `key` PK, `window_start`, `count` |

Enums are native Postgres types: `role`, `ai_task_type`, `ai_task_status`.

Migrations: `0001_initial` (hand-written so it is reviewable without a live
database) and `0002_rate_limits`.

### Tenancy and authorization

Every project-scoped query filters by `project_id` and passes through `require_project` / `RoleGate` in `backend/app/deps.py`. Non-members receive **404, not 403**, so project ids are not enumerable. The project owner always resolves to `OWNER` authority even if the membership row is missing.

Invite lifecycle: an invite for an existing email creates a `project_member` immediately; an unknown email creates a `project_invite` row that is redeemed on that address's first authenticated request (`deps.current_user`). Invitation emails are not sent; the inviter must notify the recipient separately to sign in with the invited email.

## API Surface

All routes are under `backend/app/routers/`, mounted at `/v1`. Auth is a Clerk session JWT in the `Authorization: Bearer` header, verified in `backend/app/auth.py`.

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/health` | none | Liveness. Does not touch the DB. |
| GET | `/ready` | none | Readiness. Runs `SELECT 1`. |
| GET | `/v1/projects` | member | Projects the caller belongs to |
| POST | `/v1/projects` | any user | Creates project + owner membership in one transaction |
| GET | `/v1/projects/{id}` | VIEWER | Includes members and owner |
| PATCH | `/v1/projects/{id}` | OWNER | |
| DELETE | `/v1/projects/{id}` | OWNER | Cascades to all child rows |
| GET | `/v1/projects/{id}/members` | VIEWER | |
| POST | `/v1/projects/{id}/invites` | OWNER | `202` + `InviteOut` for unknown email, `201` + `ProjectMemberOut` for known |
| GET | `/v1/projects/{id}/invites` | OWNER | Pending invites |
| DELETE | `/v1/projects/{id}/invites/{inviteId}` | OWNER | |
| DELETE | `/v1/projects/{id}/members/{userId}` | OWNER | 400 if target is the owner |
| GET | `/v1/projects/{id}/snapshots` | VIEWER | |
| POST | `/v1/projects/{id}/snapshots` | EDITOR | Uploads to Vercel Blob |
| DELETE | `/v1/projects/{id}/snapshots/{snapshotId}` | EDITOR | Delete one saved version |
| DELETE | `/v1/projects/{id}/snapshots` | EDITOR | Clear saved history |
| POST | `/v1/ai/generate` | VIEWER | `202` + task id. 429 past 3 in flight. |
| POST | `/v1/ai/spec` | VIEWER | `202` + task id |
| GET | `/v1/ai/tasks/{id}` | VIEWER | Poll status |
| POST | `/v1/webhooks/clerk` | signature | Svix HMAC verified |

Role semantics: `OWNER` > `EDITOR` > `VIEWER`. In Milestone 1 only `OWNER` actions exist; `EDITOR` gates snapshots and come with the canvas.

Response bodies are enveloped (`{"project": ...}`, `{"snapshot": ...}`) rather than bare, matching the list endpoints and leaving room for metadata later. The one exception is `POST /v1/projects/{id}/invites`, which has two outcomes: `201 {"member": {...}}` when the invitee already had an account, `202 {"invite": {...}}` when they did not. All error bodies are `{"error": "..."}`, normalised in `main.py`, except validation errors which keep a structured `detail` list.

### Rate limiting

Fixed-window counters in Postgres, keyed on **user id**, not IP:

| Scope | Limit | Window |
|---|---|---|
| `ai:generate` | 20 | 1 hour |
| `ai:spec` | 20 | 1 hour |
| `project:create` | 30 | 1 hour |
| `project:invite` | 50 | 1 hour |
| `snapshot:create` | 120 | 1 hour |

Per user because a shared NAT would let one person exhaust a shared quota, IP is trivial to rotate, and IP lockout on a cost-bearing endpoint is a denial-of-service lever against a specific victim. Postgres rather than Redis because it keeps the dependency count at zero and this is not the bottleneck; `backend/app/ratelimit.py` is the only file that changes if that stops being true.

There is **no login or register endpoint to rate limit**: sign-in and sign-up are Clerk's hosted components, and the API never sees a credential. Brute-force protection belongs to Clerk.

The AI endpoints also carry a separate in-flight cap of 3 queued-or-running tasks per project per type. That is a concurrency guard, not a budget, and returns 429 with a different message.

## Milestones

### Milestone 1: Auth + Projects (code complete)
- Clerk in the Next.js root layout; `proxy.ts` guards routes
- FastAPI service with Clerk JWT verification, role gating, project CRUD, invites
- Postgres-backed rate limiting on the cost-bearing endpoints
- Project list page, create form, project detail page with collaborator management
- 43 tests: 14 unit plus 29 integration against a real Postgres
- **Done condition**: a user signs in, creates a project, invites a collaborator by email, and the collaborator sees it after signing in. Code and integration coverage are in place; not yet exercised end-to-end against real Clerk credentials.

### Milestone 2: Real-time Canvas
- Liveblocks provider and room auth (`POST /v1/liveblocks/auth`)
- React Flow canvas with four custom node types
- Drag from palette, connect edges, delete nodes and edges
- Cursors and presence via Liveblocks
- **Done condition**: two users in the same project see each other's cursors and edits in real time.

### Milestone 3: Auto-save + Snapshots
- Debounced client autosave posting the serialized Yjs doc
- Snapshot history panel, load a snapshot back into the canvas
- **Done condition**: a snapshot appears within 30s of the last edit and restores correctly.

### Milestone 4: AI chat + Design generation
- Chat sidebar with streaming responses
- Trigger.dev worker claiming `QUEUED` rows with `FOR UPDATE SKIP LOCKED`
- AI writes nodes and edges into the Liveblocks doc
- **Done condition**: typing "Design a URL shortener" produces a diagram on canvas within 60 seconds.

### Milestone 5: AI spec export
- Spec generation task, modal with markdown preview, copy and download
- **Done condition**: a coherent markdown spec downloads from the current diagram.

### Milestone 6: Polish + Deploy
- VIEWER read-only enforcement in the UI
- Deploy Next.js to Vercel and the API to Fly.io
- **Done condition**: both services live, all prior milestones working in production.

## Risks

| Risk | Mitigation |
|---|---|
| Clerk JWKS fetch blocks the event loop | `PyJWKClient` runs in a worker thread via `anyio.to_thread`; keys are cached per process |
| Clerk profile lookup on every request | Session tokens carry no email, so profiles are cached in-process for 300s and the cache is capped at 5000 entries |
| Two services, two auth paths | Python is the only authorizer. Next.js only forwards the Clerk token and renders the result. |
| `server-only` leaking into the client bundle | `api-client.ts` is isomorphic, `api-server.ts` is server-only. Only `next build` catches this; `tsc` and `eslint` do not. |
| Clock skew rejects valid sessions | Clerk tokens allow a small leeway; `nbf` is not separately enforced |
| AI generates malformed diagram JSON | Schema validation in the task; retry once, then record the error on the task row (Milestone 4) |
| Rate limiter is the AI cost control | Per-user hourly budgets on both AI endpoints, plus an in-flight cap. Redis is the upgrade path if volume grows. |
| Two hosts means cross-origin latency | Next.js server calls the API over its internal URL; browser calls are CORS-restricted to `CORS_ORIGINS` |
| Port clash with a local Postgres | Compose publishes on 55432, documented in the README |
| Node install corruption on Windows | See "Environment note" below |

## Testing and Observability

### Unit tests (pytest, `backend/tests/`)
14 tests, no database required: `Role.allows` ordering, schema validation
(blank names, length caps, `OWNER` not grantable by invite), and Clerk JWT
verification (valid subject, expired, empty, missing subject).

### Integration tests
29 tests against a real Postgres, skipped unless `TEST_DATABASE_URL` is set:

- Project CRUD, user upsert on first request, creator becomes OWNER with a
  membership row
- Listing scoped to the caller
- Non-members get 404 rather than 403
- Blank names rejected; only the owner can rename
- Delete cascades to members, invites, snapshots and tasks
- Invite lifecycle: a known email becomes a member immediately; an unknown email
  is stored pending and **redeems on that address's first sign-in**; re-inviting
  updates the role instead of duplicating; revoking stops a later sign-in joining
- Invite requires OWNER; `OWNER` cannot be granted; the owner cannot be removed
- Rate limits: budget exhaustion returns 429 with `Retry-After`; budgets are
  per-user, not global; a rejected request creates nothing; the window rolls
  over and the counter resets; `peek` does not consume

The concurrency test asserts two simultaneous increments produce `[2, 3]`, not
`[2, 2]`. That is the assertion that fails if the counter ever becomes a
read-then-write.

The schema is built by running the real Alembic migrations in a subprocess rather
than `metadata.create_all`, so the migrations are covered too.

### Observability
- Structured logging via `logging` with task ids on AI enqueue
- `/health` and `/ready` for uptime and deploy gating
- Trigger.dev dashboard for AI job latency and failures (Milestone 4)
- Sentry for both services (Milestone 6)

### Local stack

`docker-compose.yml` runs Postgres and the API. Postgres publishes on host port
**55432**, not 5432: a locally installed Postgres is a common thing to already
be listening, and that clash fails confusingly because Docker still reports the
port published while the other server keeps answering.

## Deployment

| Piece | Target | Notes |
|---|---|---|
| `frontend/` | Vercel | Auto-deploy on push. `GHOST_API_URL` should point at the API's internal address. |
| `backend/` | Fly.io or Railway | `backend/Dockerfile` runs `alembic upgrade head` then uvicorn on boot, so a deploy never serves requests against an old schema. |
| Postgres | Neon or any managed Postgres | Shared by the API and the worker. Use the pooled URL for runtime, direct for migrations. |
| `frontend/trigger/` | Trigger.dev cloud | Deploy with `npx trigger.dev@latest deploy`. |

Secrets: `backend/.env.example` and `frontend/.env.example` list every variable. Neither `.env` is committed (`.gitignore` has `.env*`).

### Environment note

`npm install` in `frontend/` has repeatedly failed or timed out on this Windows machine (`EPERM` on partially-extracted packages, then a corrupt `node_modules`). The working tree at time of writing was recovered by `rm -rf node_modules package-lock.json && npm install`. If lint fails with `Cannot find module .../zod/v4/index.cjs` or similar, the tree is corrupt again and a clean reinstall is the fix. This is an environment problem, not a code problem.

## Open Questions and Assumptions

1. **Fly.io vs Railway** — not yet chosen. Both satisfy the requirement; Fly.io's private networking suits the Next.js server-to-API hop better. Assumed Fly.io in the deployment table.
2. **AI provider** — the original spec assumed OpenAI `gpt-4o`. Not yet installed or configured; no AI route calls a model today.
3. **Canvas library** — `@xyflow/react` (React Flow), adds roughly 50KB. A custom SVG canvas is possible but substantially more work.
4. **v1 AI generates from scratch only.** Incremental edits such as "add a cache layer" are out of scope and are a likely v2.
5. **Snapshot retention** — capped at 100 index rows per project. Blobs are never deleted; pruning them is not implemented.
6. **No per-user AI rate limiting** beyond 3 in-flight tasks per project. At scale, per-user quotas will be needed.
7. **Cross-service type drift** — `frontend/lib/types.ts` is a hand-maintained mirror of `backend/app/schemas.py`. It should be generated from the OpenAPI schema rather than edited by hand.