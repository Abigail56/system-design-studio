import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts`, at the same level as `app/`.
 * Signature is `proxy(request: NextRequest)` -- one argument, per
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
 *
 * This guards only the Next.js app's own routes. The API in `../backend`
 * verifies the Clerk session JWT itself and is not covered here.
 */

/**
 * Local development escape hatch: reach the app without a Clerk account.
 *
 * Skips `auth.protect()` but still runs Clerk's middleware, so the request gets a
 * real auth context and `auth()` keeps working server-side. Earlier this bypassed
 * Clerk entirely, which broke `auth()` and left pages hanging.
 *
 * Not the only guard: the API refuses to boot with DEV_AUTH set while
 * ENVIRONMENT=production, so this cannot reach a deploy by accident.
 */
const devAuth = process.env.DEV_AUTH === "true";

/**
 * `createRouteMatcher` is deprecated in Clerk v7 in favour of per-page checks.
 * A path test keeps the guard in one place without the deprecated helper.
 */
const PUBLIC_PATH = /^\/(sign-in|sign-up)(\/|$)/;

export default clerkMiddleware(
  async (auth, req) => {
    if (devAuth) return;
    if (PUBLIC_PATH.test(req.nextUrl.pathname)) return;
    await auth.protect();
  },
  {
    // `auth.protect()` resolves its redirect target from here. Without these it
    // sends unauthenticated visitors to Clerk's hosted pages on
    // *.accounts.dev, bypassing this app's own sign-in and sign-up screens.
    signInUrl: "/sign-in",
    signUpUrl: "/sign-up",
  },
);

export const config = {
  matcher: [
    // Everything except Next internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Keep auth available to any future route handlers under /api.
    "/(api|trpc)(.*)",
  ],
};