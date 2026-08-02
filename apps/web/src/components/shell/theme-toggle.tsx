"use client";

import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

/**
 * The theme lives on <html> (set by the inline script in the root layout before
 * first paint), not in React state. So this reads that external value with
 * useSyncExternalStore rather than mirroring it into local state — which would
 * mean a setState-in-effect and a cascading render.
 *
 * The server snapshot is null: the server cannot know the stored preference, so
 * the button renders label-less until hydration instead of guessing wrong.
 */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

const getSnapshot = (): Theme =>
  document.documentElement.classList.contains("dark") ? "dark" : "light";

const getServerSnapshot = (): Theme | null => null;

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    // Mutating the class fires the MutationObserver above, which re-renders us.
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("ledgerly-theme", next);
    } catch {
      // Private mode / storage disabled — the toggle still works for this page.
    }
  }

  const label =
    theme === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      onClick={toggle}
      title={theme ? label : undefined}
      aria-label={theme ? label : "Toggle theme"}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-raised hover:text-ink"
    >
      {theme === null ? (
        // The server cannot know the stored preference. Rendering either icon
        // would paint the wrong one for half of all users and then visibly
        // swap on hydration, so hold a same-size blank until the theme is known.
        <span className="h-[18px] w-[18px]" aria-hidden />
      ) : theme === "light" ? (
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
        </svg>
      ) : (
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M20 13.4A8.2 8.2 0 1 1 10.6 4a6.6 6.6 0 0 0 9.4 9.4z" />
        </svg>
      )}
    </button>
  );
}
