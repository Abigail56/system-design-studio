"use client";

import { useSyncExternalStore } from "react";
import { useUser } from "@clerk/nextjs";

const devAuth = process.env.NEXT_PUBLIC_DEV_AUTH === "true";

function currentGreeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function subscribeToGreeting(onChange: () => void) {
  const interval = window.setInterval(onChange, 60_000);
  return () => window.clearInterval(interval);
}

export function DashboardWelcome() {
  if (devAuth) return <Welcome name="there" />;
  return <ClerkWelcome />;
}

function ClerkWelcome() {
  const { isLoaded, user } = useUser();
  const name = isLoaded ? user?.firstName?.trim() || "there" : "there";
  return <Welcome name={name} />;
}

function Welcome({ name }: { name: string }) {
  const greeting = useSyncExternalStore(
    subscribeToGreeting,
    currentGreeting,
    () => "Welcome",
  );

  return (
    <div>
      <p className="mb-5 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
        <span aria-hidden className="size-1.5 rounded-full bg-[var(--accent)]" />
        A little room for big ideas
      </p>
      <h1 className="editorial-heading max-w-xl text-4xl font-medium leading-[1.08] sm:text-5xl">
        {greeting}, {name}.
      </h1>
      <p className="mt-5 max-w-lg text-[15px] leading-7 text-[var(--fg-muted)] sm:text-base">
        Welcome. Pick up where your team left off, or make a little space for
        something new.
      </p>
    </div>
  );
}
