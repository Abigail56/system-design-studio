import Link from "next/link";
import { UserMenu } from "@/components/layout/UserMenu";
import { ThemeToggle } from "@/components/layout/ThemeToggle";

/**
 * App shell shown on every page. Sign-in is enforced by `proxy.ts`, so this
 * only renders the identity controls.
 *
 * `fullHeight` is for the workspace, where the canvas should fill the viewport
 * rather than sit inside a scrolling page.
 */
export default function AppShell({
  children,
  fullHeight = false,
  dashboard = false,
  workspace = false,
}: {
  children: React.ReactNode;
  fullHeight?: boolean;
  dashboard?: boolean;
  workspace?: boolean;
}) {
  return (
    <div
      className={[
        fullHeight ? "flex h-screen flex-col overflow-hidden" : "flex min-h-full flex-col",
        dashboard ? "dashboard-shell" : "",
        workspace ? "workspace-shell" : "",
      ].join(" ")}
    >
      <header className="sticky top-0 z-30 h-14 shrink-0 border-b border-[var(--border)] bg-[var(--chrome)] backdrop-blur-md">
        <div className="mx-auto flex h-full w-full max-w-[1600px] items-center justify-between px-5">
          <Link
            href="/projects"
            className="group flex items-center gap-3 rounded-md outline-none"
          >
            <span className="grid size-8 place-items-center rounded-xl bg-[var(--accent)] font-[family-name:var(--font-display)] text-sm font-bold text-[var(--accent-fg)] shadow-[var(--shadow-sm)] transition-transform duration-200 group-hover:scale-105">
              S
            </span>
            <span className="leading-tight">
              <span className="block font-[family-name:var(--font-display)] text-sm font-semibold tracking-tight">
                System Design Studio
              </span>
              <span className="mt-0.5 hidden text-[10px] text-[var(--fg-subtle)] sm:block">
                Think clearly. Build together.
              </span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </header>

      <main className={fullHeight ? "min-h-0 flex-1" : "flex-1"}>{children}</main>
    </div>
  );
}