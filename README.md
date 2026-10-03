# Ghost AI

Real-time collaborative system design workspace. Several engineers draw architecture diagrams on a shared canvas while an AI agent generates designs, answers questions, and writes an implementation spec.

## The two services

| Path | Stack | Port | Responsibility |
|---|---|---|---|
| **`frontend/`** | Next.js 16 App Router, TypeScript | 3000 | UI, page rendering, Clerk session. No database. |
| **`backend/`** | FastAPI, SQLAlchemy 2.0 async | 8000 | All HTTP API, all authorization, all data. |
| `docker-compose.yml` | Postgres 16 | 55432 | The database both services depend on. |

**The one rule: only `backend/` touches the database.** Next.js has no ORM and issues no queries, so role checks cannot drift between a server component and an API handler.

```
Browser ──► frontend/ (Next.js)                Clerk holds the session
             │  Authorization: Bearer <session token>
             ▼
          backend/ (FastAPI) ──► Postgres        verifies the JWT, owns all data
```

## Run it

Fastest path — all three services:

```bash
./dev.ps1          # Windows PowerShell
./dev.sh           # macOS / Linux / Git Bash
```

Or by hand, three terminals:

```bash
# 1. database
docker compose up -d db

# 2. backend  ->  http://localhost:8000  (docs at /docs)
cd api
uv venv
uv pip install -e ".[dev]"
cp .env.example .env
alembic upgrade head
.venv/Scripts/python.exe -m uvicorn app.main:app --port 8000 --reload

# 3. frontend  ->  http://localhost:3000
cd ghost
npm install
cp .env.example .env.local
npm run dev
```

Open <http://localhost:3000>. It redirects to `/projects`.

### Invite someone on the same Wi-Fi

For local testing on another device on your private Wi-Fi, use the host
computer's Wi-Fi IPv4 address instead of `localhost`. Configure
`frontend/.env.local` with `NEXT_PUBLIC_GHOST_API_URL=http://<host-ip>:8000`,
and configure `backend/.env` with
`FRONTEND_URL=http://<host-ip>:3000` and include that exact origin in
`CORS_ORIGINS`. The frontend dev server binds to network interfaces; restart it
after changing `.env.local`. Recreate the API container after changing
`backend/.env`.

The invitee opens `http://<host-ip>:3000/projects/<project-id>` and signs in or
signs up with the exact email address invited. Both devices must remain on the
same trusted private network. Allow Node.js and Docker through Windows Firewall
for **private networks only** if prompted. Do not port-forward these development
ports or expose them to the public internet. The database port remains bound to
localhost and is not shared over Wi-Fi.

### Database port is 55432, not 5432

A locally installed Postgres is a common thing to already be listening on 5432, and that clash fails *confusingly*: Docker reports the port published while the other server keeps answering, so you get "password authentication failed" from a database you never connected to. Override with `POSTGRES_PORT` if you need to.

## Auth

Two ways to sign in, chosen in `frontend/.env.local` and `backend/.env`.

**Dev auth (on by default here).** `DEV_AUTH=true` gives you a fixed local identity so the app runs with no Clerk account. An amber banner shows in the app. To leave it: delete the `DEV_AUTH` lines and add real Clerk keys.

This is guarded, not just documented. `backend/app/config.py` **refuses to boot** if `DEV_AUTH` is set while `ENVIRONMENT=production`, so a dev bypass cannot reach a deploy by accident:

```
RuntimeError: DEV_AUTH is enabled but ENVIRONMENT=production. Refusing to start.
```

**Real Clerk.** Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in both files and drop `DEV_AUTH`. Sign-in and sign-up are Clerk's hosted components; the API verifies the session JWT directly against Clerk's public keys.

## Tests

```bash
cd api && pytest
```

14 unit tests plus 30 integration tests, no infrastructure needed for the first set. For the integration set:

```bash
docker compose up -d db
docker compose exec -T db psql -U ghost -d ghost -c "CREATE DATABASE ghost_test;"
cd api
export TEST_DATABASE_URL=postgresql+asyncpg://ghost:ghost@localhost:55432/ghost_test
pytest
```

Database tests skip when `TEST_DATABASE_URL` is unset, so a bare `pytest` never runs destructive SQL against whatever `DATABASE_URL` points at. The suite also forces `DEV_AUTH=false` so a local `.env` cannot quietly bypass auth in tests.

Frontend:

```bash
cd ghost && npx tsc --noEmit && npx eslint . && npx next build
```

`next build` matters more than it looks: it is the only step that catches `server-only` leaking into a Client Component, which `tsc` and `eslint` both pass over.

## Status

| Milestone | State |
|---|---|
| 1. Auth + Projects | Code complete, 54 tests passing, verified rendering in a browser |
| 2. Real-time canvas | Not started |
| 3. Auto-save + snapshots | Backend route written; client autosave not started |
| 4. AI chat + generation | Task queue and rate limits written; the worker that drains the queue is not started |
| 5. AI spec export | Not started |
| 6. Deploy | Not started |

See `specs/project-ghost-ai.md` for the full design.

## Known environment issue

This project lives inside a OneDrive-synced folder, which holds file locks on `node_modules`. `npm install`, `npm install <pkg>`, and `rm -rf node_modules` have all failed here with `EPERM` or `Permission denied`, leaving a partially-extracted tree that later fails with errors like `Cannot find module .../zod/v4/index.cjs`.

If you hit those, move the checkout out of OneDrive or pause OneDrive sync, then reinstall. Environment issue, not a code issue.

## Docs

- `specs/project-ghost-ai.md` — architecture, data model, API surface, milestones
- `backend/README.md` — backend layout, migrations, auth model, rate limiting