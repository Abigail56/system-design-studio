# Production deployment

## Choose an architecture

**Recommended: Vercel frontend + Render API + Render Postgres.** Deploy `frontend/`
as a Next.js project on Vercel; deploy `backend/` as a Docker web service on Render
and put its Postgres database in the same Render region. The browser calls the
API's public HTTPS URL; only the API uses Postgres. ([Vercel monorepos](https://vercel.com/docs/monorepos),
[Render web services](https://render.com/docs/web-services),
[Render Postgres connections](https://render.com/docs/postgresql-creating-connecting),
[project architecture](README.md))

**All Render is also viable.** Run the frontend as a Node web service and the API
as a Docker web service, with Postgres in their region. The browser-facing
`NEXT_PUBLIC_GHOST_API_URL` must still be the API's public URL, not a Render
private-network address. ([Render web services](https://render.com/docs/web-services),
[frontend configuration](frontend/lib/api-client.ts))

**Railway is also viable.** Deploy the backend and frontend as separate Railway
services; the Railway-specific setup is below. ([Railway monorepo deployments](https://docs.railway.com/deployments/monorepo))

## Deploy in this order

1. **Create Render Postgres.** Choose the region where the API will run and copy
   the database's **internal** URL; Render recommends this same-region path for
   lower-latency private-network connections. Set the API's `DATABASE_URL` to
   that URL, changing its scheme to `postgresql+asyncpg://` for this app's
   SQLAlchemy async driver; preserve the remaining URL unchanged. ([Render
   Postgres](https://render.com/docs/postgresql-creating-connecting),
   [SQLAlchemy asyncpg URL format](https://docs.sqlalchemy.org/en/20/dialects/postgresql.html#asyncpg),
   [database engine](backend/app/db.py))

2. **Deploy the API on Render.** Create a Docker web service with **Root
   Directory** `backend` and **Dockerfile Path** `Dockerfile`. The existing
   Dockerfile starts Uvicorn on port `8000`, so set Render's `PORT` to `8000`
   (Render's default is `10000`). Set its health-check path to `/ready` to check
   database connectivity; `/health` is liveness-only. The Docker startup command
   applies `alembic upgrade head` before starting Uvicorn. ([Render web
   services/port binding](https://render.com/docs/web-services), [Render health
   checks](https://render.com/docs/health-checks), [API Dockerfile](backend/Dockerfile),
   [health endpoints](backend/app/main.py))

   Add these API environment variables in the Render service's **Environment**
   settings (not in source):

   | Variable | Set to |
   | --- | --- |
   | `DATABASE_URL` | Render internal URL, with the asyncpg scheme above |
   | `CLERK_SECRET_KEY` | Clerk **production** secret key |
   | `ENVIRONMENT` | `production` |
   | `DEV_AUTH` | `false` |
   | `CORS_ORIGINS` | Exact frontend origin(s), comma-separated, e.g. `https://app.example.com` |
   | `FRONTEND_URL` | Frontend base URL without a trailing slash; used for invite links |

   `DATABASE_URL` and `CLERK_SECRET_KEY` are required by the API settings;
   `DEV_AUTH=true` is rejected in production. ([API settings](backend/app/config.py),
   [invite URL configuration](backend/README.md), [Render environment
   variables](https://render.com/docs/configure-environment-variables))

   **Clerk webhook release blocker:** `backend/app/routers/webhooks.py` reads
   `settings.clerk_webhook_secret`, but `backend/app/config.py` does not define
   that setting. Although `backend/.env.example` lists `CLERK_WEBHOOK_SECRET`,
   `extra="ignore"` means adding it to Render's environment alone will not make
   it available: a request to `/webhooks/clerk` will fail when accessing the
   missing attribute. Deploy the API with Clerk webhooks disabled until the
   setting is added to `Settings` and the webhook path is tested; then configure
   the Clerk signing secret as API-side `CLERK_WEBHOOK_SECRET`. This does not
   block other API routes. ([webhook handler](backend/app/routers/webhooks.py),
   [API settings](backend/app/config.py),
   [backend env template](backend/.env.example))

   After deploy, verify `curl.exe -fsS https://<api-host>/ready` returns
   `{"status":"ready"}` and check Render logs for the migration and startup.
   ([health endpoint](backend/app/main.py), [Render health checks](https://render.com/docs/health-checks))

3. **Deploy the frontend on one platform.**

   - **Vercel:** Import the repository and set the project's **Root Directory**
     to `frontend`; use the detected Next.js framework defaults. Add the
     frontend variables below for Production (and separately for Preview only
     if you intentionally support preview deployments), then deploy. ([Vercel
     monorepos](https://vercel.com/docs/monorepos), [Next.js `proxy.ts`
     convention](https://nextjs.org/docs/app/api-reference/file-conventions/proxy),
     [Vercel environment variables](https://vercel.com/docs/environment-variables))
   - **Render:** Create a Node web service with root directory `frontend`, build
     command `npm ci && npm run build`, and start command
     `npm start -- --hostname 0.0.0.0 --port $PORT`. These match the project's
     lockfile and scripts. ([Render web services](https://render.com/docs/web-services),
     [frontend scripts](frontend/package.json))

   Set the following on the frontend service/project:

   | Variable | Set to |
   | --- | --- |
   | `NEXT_PUBLIC_GHOST_API_URL` | Public Render API URL accessible from users' browsers, e.g. `https://<api-host>`; never a Render internal/private URL |
   | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk production publishable key |
   | `CLERK_SECRET_KEY` | Clerk production secret key; server-side only |
   | `NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY` | Liveblocks public `pk_…` key |
   | `LIVEBLOCKS_SECRET_KEY` | Liveblocks secret key; server-side only |
   | `DEV_AUTH` and `NEXT_PUBLIC_DEV_AUTH` | `false` |

   Only values intended for browsers belong under `NEXT_PUBLIC_`: Next.js
   inlines these into client JavaScript at build time. Vercel variable changes
   require a new deployment. ([Next.js environment variables](https://nextjs.org/docs/app/guides/environment-variables),
   [Vercel environment variables](https://vercel.com/docs/environment-variables),
   [frontend env usage](frontend/lib/api-client.ts),
   [Liveblocks auth route](frontend/app/api/liveblocks/auth/route.ts))

   This Next.js 16 app uses `frontend/proxy.ts`; deploy it as a standard Next.js
   project so the framework's `proxy.ts` convention is included. Both
   `NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY` and server-only `LIVEBLOCKS_SECRET_KEY`
   must be set to the production project's matching keys for collaboration.
   The env templates contain placeholders, not a production keypair; without
   `LIVEBLOCKS_SECRET_KEY`, the auth route returns HTTP 503. ([Next.js
   `proxy.ts` convention](https://nextjs.org/docs/app/api-reference/file-conventions/proxy),
   [app version and scripts](frontend/package.json),
   [proxy implementation](frontend/proxy.ts),
   [frontend env template](frontend/.env.example),
   [Liveblocks auth route](frontend/app/api/liveblocks/auth/route.ts))

4. **Connect production domains and providers.** In Clerk, use the Production
   instance and its live keys, configure the app's production domain/DNS and
   redirect settings, and use those keys in both the frontend and API. ([Clerk
   production deployment](https://clerk.com/docs/guides/development/deployment/production),
   [Clerk environment variables](https://clerk.com/docs/guides/development/clerk-environment-variables))
   Configure the Clerk instance to enable both Google and email/password
   sign-in, require email verification for new or changed addresses, and
   enforce multi-factor verification (for example, an email one-time code) on
   sign-in. These are Clerk instance settings, not frontend-only switches; the
   app renders Clerk's configured verification flow. The sign-in form also
   requests Google's account chooser, and the user menu's **Switch account**
   action signs out and returns to `/sign-in`. ([Clerk authentication
   configuration](https://clerk.com/docs), [sign-in component](frontend/app/(auth)/ClerkAuthPage.tsx),
   [account menu](frontend/components/layout/UserMenu.tsx))
   Set `CORS_ORIGINS` to the exact browser origin and `FRONTEND_URL` to the
   same base URL; add any deliberate Vercel preview origin explicitly rather
   than using a wildcard. ([API CORS configuration](backend/app/main.py),
   [FastAPI CORS guidance](https://fastapi.tiangolo.com/tutorial/cors/))

   This app mints room-scoped Liveblocks access tokens in its Next.js
   `/api/liveblocks/auth` route after checking Clerk identity and API membership;
   keep `LIVEBLOCKS_SECRET_KEY` on the frontend server and deploy with a
   production Liveblocks key. The official Next.js access-token guide documents
   this server-endpoint pattern. In Liveblocks project settings, restrict any
   available **Allowed Origins** control to the exact production frontend
   origin; I could not verify a current official doc specifying a required
   origin-setting name, so confirm the control in the Liveblocks dashboard.
   ([Liveblocks Next.js access-token auth](https://liveblocks.io/docs/api-reference/authentication/access-token/nextjs),
   [Liveblocks authentication](https://liveblocks.io/docs/api-reference/authentication),
   [project auth route](frontend/app/api/liveblocks/auth/route.ts))

## Railway deployment (alternative)

Create two services from this repository. Railway supports monorepos by setting
a separate **Root Directory** for each service. ([Railway monorepo deployments](https://docs.railway.com/deployments/monorepo))

1. **Backend:** Add a Railway PostgreSQL service, then create a backend service
   with **Root Directory** `/backend`, **Builder** `Dockerfile`, and
   **Dockerfile Path** `/Dockerfile`. ([Railway monorepos](https://docs.railway.com/deployments/monorepo),
   [Dockerfiles](https://docs.railway.com/builds/dockerfiles),
   [PostgreSQL](https://docs.railway.com/databases/postgresql))

   Set `DATABASE_URL` to the database URL using the `postgresql+asyncpg://`
   scheme; set `CLERK_SECRET_KEY`, `ENVIRONMENT=production`, `DEV_AUTH=false`,
   `CORS_ORIGINS` to the frontend's exact public origin, and `FRONTEND_URL` to
   that origin without a trailing slash. Also set `PORT=8000`: the existing
   Dockerfile binds Uvicorn to `0.0.0.0:8000`, while Railway otherwise injects
   `PORT` for routing and health checks. Add optional provider/email variables
   as needed. ([Railway variables](https://docs.railway.com/variables),
   [Railway port binding](https://docs.railway.com/networking/troubleshooting/application-failed-to-respond),
   [Railway health checks](https://docs.railway.com/deployments/healthchecks),
   [SQLAlchemy asyncpg URL](https://docs.sqlalchemy.org/en/20/dialects/postgresql.html#asyncpg),
   [backend Dockerfile](backend/Dockerfile),
   [backend settings](backend/app/config.py))

   Set the health-check path to `/ready`, which checks database connectivity.
   Railway activates a deployment after a `2xx` response but does not monitor
   it continuously. Verify the public URL with
   `curl.exe -fsS https://<backend-domain>/ready`; expect
   `{"status":"ready"}`. ([Railway health checks](https://docs.railway.com/deployments/healthchecks),
   [health endpoint](backend/app/main.py))

2. **Frontend:** Create a second service with **Root Directory** `/frontend`.
   Use detected Node settings, or set Build Command `npm run build` and Start
   Command `npm start -- --hostname 0.0.0.0 --port ${PORT-3000}` so Next.js
   listens on Railway's port. ([Railway build and start commands](https://docs.railway.com/builds/build-and-start-commands),
   [Next.js port binding](https://docs.railway.com/networking/troubleshooting/application-failed-to-respond),
   [frontend scripts](frontend/package.json))

   Configure `NEXT_PUBLIC_GHOST_API_URL` as the backend's public HTTPS URL,
   `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, server-only `CLERK_SECRET_KEY`,
   `NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY`, server-only `LIVEBLOCKS_SECRET_KEY`,
   and `DEV_AUTH=false` / `NEXT_PUBLIC_DEV_AUTH=false`. Set `NEXT_PUBLIC_`
   variables before the build. Generate public domains in each service's
   Networking settings; the API URL can use
   `https://${{backend.RAILWAY_PUBLIC_DOMAIN}}` (substitute the backend service
   name). Set backend `CORS_ORIGINS` and `FRONTEND_URL` to the frontend domain.
   ([Railway public networking](https://docs.railway.com/networking/public-networking),
   [Railway reference variables](https://docs.railway.com/variables),
   [Next.js environment variables](https://nextjs.org/docs/app/guides/environment-variables),
   [frontend API configuration](frontend/lib/api-client.ts))

   Keep Clerk webhooks disabled until the missing application setting
   described in the Render API instructions is implemented and tested.

## Optional email and AI integrations

- **Invitations by email:** Set API-side `RESEND_API_KEY` and
  `RESEND_FROM_EMAIL`; verify the sending domain in Resend and use an address
  on that domain. ([Resend verified domains](https://resend.com/docs/dashboard/domains/introduction),
  [Resend API keys](https://resend.com/docs/dashboard/api-keys/introduction),
  [app settings](backend/app/config.py))
- **AI:** Configure one backend provider key, `OPENROUTER_API_KEY` or
  `OPENAI_API_KEY`; the API also supports `OPENROUTER_MODEL`,
  `OPENROUTER_HTTP_REFERER`, and `OPENAI_MODEL`. OpenRouter documents setting
  per-key credit limits; keep either provider key server-side. ([app provider
  settings](backend/app/config.py), [OpenRouter authentication and key
  limits](https://openrouter.ai/docs/api_reference/authentication), [OpenAI API
  key safety](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety))

## Final checks

- Set Vercel Function region near the Render API region if server-rendered
  requests are latency-sensitive; Vercel's static content is served through
  its CDN. If this app's route needs a longer execution window, configure
  `maxDuration` within the current plan limit; verify after measuring rather
  than assuming a particular limit. ([Vercel function regions](https://vercel.com/docs/functions/configuring-functions/region),
  [function duration](https://vercel.com/docs/functions/configuring-functions/duration),
  [current auth route](frontend/app/api/liveblocks/auth/route.ts))
- Verify sign-in, project loading, a browser request to the API, collaboration,
  and an invitation email if enabled; keep Clerk webhooks disabled until the
  configuration blocker above is fixed and verified. Confirm only the intended
  frontend origin is allowed by API CORS. ([API CORS](backend/app/main.py),
  [Render health checks](https://render.com/docs/health-checks))

> **Secret handling:** Never paste secrets into chat, tickets, issue trackers,
> screenshots, or source control. Enter them only in the provider's secret
> environment-variable settings; never prefix a secret with `NEXT_PUBLIC_`.
> If a credential is exposed, revoke/rotate it immediately. ([Render environment
> variables](https://render.com/docs/configure-environment-variables),
> [Next.js environment variables](https://nextjs.org/docs/app/guides/environment-variables),
> [OpenAI key safety](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety))
