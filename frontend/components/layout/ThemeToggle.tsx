"use client";

import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "ghost:theme";
const CHANGE_EVENT = "ghost:theme-change";

/**
 * Runs before first paint to set `data-theme` on <html>.
 *
 * Without this the server has no idea what the user chose, so it renders the
 * default and then swaps: a visible flash on every navigation. Inlined as raw
 * text because a blocking script is the whole point, and `next/script` would
 * run after hydration.
 */
export const themeScript = `(function(){try{
var t=localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";}
document.documentElement.setAttribute("data-theme",t);
}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/**
 * Subscribe to theme changes with `useSyncExternalStore` rather than reading the
 * DOM in an effect and calling setState. The attribute on <html> is the single
 * source of truth, shared with the inline script above, so two toggles anywhere
 * in the tree stay in step without any prop drilling.
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Failing to persist is not worth breaking the toggle over; the theme still
    // applies for this page view.
  }
  // Tell every other subscriber, including other toggles.
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useTheme(): [Theme, () => void] {
  // The server cannot know the stored preference, so it renders the default
  // that matches the `data-theme` already on <html>.
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "dark" as const);

  const toggle = useCallback(() => {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  }, []);

  return [theme, toggle];
}

export function ThemeToggle() {
  const [theme, toggle] = useTheme();
  const goingTo = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${goingTo} theme`}
      title={`${goingTo[0].toUpperCase()}${goingTo.slice(1)} theme`}
      className="grid size-8 place-items-center rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] text-[var(--fg-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--fg)]"
    >
      <ThemeIcon theme={theme} />
    </button>
  );
}

/** Sun in light mode, moon in dark: the icon shows the target, not the state. */
function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === "light") {
    return (
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }

  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}