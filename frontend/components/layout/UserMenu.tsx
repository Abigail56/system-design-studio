"use client";

import { UserButton, useClerk, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { useState } from "react";

/**
 * Clerk control buttons.
 *
 * Uses `useUser()` rather than `<SignedIn>` / `<SignedOut>`: those components
 * were removed from Clerk's core and now throw
 * "`<SignedIn>` is not available in @clerk/nextjs Core 3".
 *
 * `NEXT_PUBLIC_DEV_AUTH` is read here because this is a Client Component, where
 * non-public env vars are not inlined. It carries no secret and only toggles
 * whether these controls render.
 */
const devAuth = process.env.NEXT_PUBLIC_DEV_AUTH === "true";

/**
 * Dev-auth identity. Deliberately a separate component rather than an early
 * return: `useUser()` throws when no `<ClerkProvider>` is mounted, and the
 * layout omits the provider in dev-auth mode. Splitting the branch keeps each
 * component's hooks unconditional, which is what the rule actually requires.
 */
function DevIdentity() {
  return (
    <span className="text-sm text-[var(--fg-muted)]">
      Local developer <span className="text-xs">(dev auth)</span>
    </span>
  );
}

export function UserMenu() {
  if (devAuth) return <DevIdentity />;
  return <ClerkIdentity />;
}

function ClerkIdentity() {
  const { isLoaded, user } = useUser();
  const { signOut } = useClerk();
  const [signOutError, setSignOutError] = useState<string | null>(null);

  // `isLoaded` matters: before Clerk resolves, `user` is null even for a signed
  // in visitor, which would flash the Sign in link on every page load.
  if (!isLoaded) {
    return <span className="h-8 w-20 animate-pulse rounded-md bg-[var(--bg-raised)]" />;
  }

  if (!user) {
    return (
      <Link
        href="/sign-in"
        className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
      >
        Sign in
      </Link>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={async () => {
            setSignOutError(null);
            try {
              await signOut({ redirectUrl: "/sign-in" });
            } catch {
              setSignOutError("Could not sign out. Please try again.");
            }
          }}
          className="text-xs text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          Switch account
        </button>
        <UserButton />
      </div>
      {signOutError ? (
        <span role="alert" className="text-xs text-[var(--danger)]">
          {signOutError}
        </span>
      ) : null}
    </div>
  );
}