import { Wordmark } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/shell/theme-toggle";

/** Centered, unauthenticated shell for /login and /signup. */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between px-5 py-5">
        <Wordmark />
        <ThemeToggle />
      </header>

      <main
        id="main"
        className="flex flex-1 items-center justify-center px-5 pb-20"
      >
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
