import Link from "next/link";

/**
 * Dev-auth placeholder. Shared by the sign-in and sign-up pages so the two
 * routes cannot drift apart.
 *
 * `proxy.ts` allows both paths through unauthenticated, so this only renders
 * when DEV_AUTH is explicitly switched on locally.
 */
function DevAuthNotice() {
  return (
    <main className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-lg font-semibold tracking-tight">Dev auth is enabled</h1>
        <p className="mt-2 text-sm text-[var(--fg-muted)]">
          Clerk is bypassed, so there is nothing to sign in to.
        </p>
        <Link
          href="/projects"
          className="mt-6 inline-block rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Go to projects
        </Link>
      </div>
    </main>
  );
}

/**
 * Real Clerk form.
 *
 * The URLs live on `<ClerkProvider>` in the root layout, which is the single
 * place they need to be set: it is what `auth.protect()` reads to decide where
 * to send an unauthenticated visitor, and Clerk inherits it from there for the
 * "Don't have an account? Sign up" footer link on these forms. Repeating them
 * here would just be a second place to forget.
 */
export async function ClerkAuthPage({
  mode,
}: {
  mode: "sign-in" | "sign-up";
}) {
  if (process.env.DEV_AUTH === "true") return <DevAuthNotice />;

  const { SignIn, SignUp } = await import("@clerk/nextjs");

  return (
    <main className="grid min-h-screen place-items-center px-6">
      {mode === "sign-in" ? <SignIn /> : <SignUp />}
    </main>
  );
}
