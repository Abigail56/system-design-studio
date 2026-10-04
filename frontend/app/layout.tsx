import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { themeScript } from "@/components/layout/ThemeToggle";

/**
 * Three faces, each with a job:
 *
 * - **Space Grotesk** for headings. Distinctive, technical, slightly quirky
 *   letterforms that suit a systems-design tool better than a neutral grotesque.
 * - **Inter** for interface text. Extremely legible at 12-14px, which is most of
 *   what this app renders.
 * - **JetBrains Mono** for anything machine-shaped: technology tags on canvas
 *   nodes, ids, metric values.
 *
 * All three are variable fonts, so weights and optical sizing come from one file
 * each rather than a request per weight.
 */
const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "System Design Studio — collaborative architecture design",
  description:
    "Design system architectures together in real time with collaborative diagrams and AI-powered guidance.",
};

const devAuth = process.env.DEV_AUTH === "true";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // ClerkProvider must sit inside <body>, never wrap <html>. It renders its own
  // elements and reads document-level state on mount, so wrapping the document
  // element leaves the prebuilt forms unable to mount.
  //
  // In dev-auth mode there is no Clerk session, so the provider is omitted
  // entirely: it validates the publishable key on mount and there is nothing to
  // validate against.
  const content = (
    <>
      {devAuth ? (
        <div className="border-b border-[var(--warning)]/25 bg-[var(--warning)]/10 px-4 py-1.5 text-center text-[11px] font-medium text-[var(--warning)]">
          DEV_AUTH is on — Clerk is bypassed. Local development only.
        </div>
      ) : null}
      {children}
    </>
  );

  return (
    <html
      lang="en"
      className={`${sans.variable} ${display.variable} ${mono.variable} antialiased`}
      // Matches the inline script below, so the very first paint is correct.
      data-theme="dark"
      suppressHydrationWarning
    >
      <head>
        {/* Blocking on purpose: it must run before the body paints, or the
            stored theme flashes the wrong colours on every navigation. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full bg-[var(--bg)] text-[var(--fg)]">
        {devAuth ? (
          content
        ) : (
          // These URLs must be set here, not only on <SignIn>/<SignUp>. Left
          // empty, `auth.protect()` redirects to Clerk's hosted pages on
          // *.accounts.dev instead of this app's own /sign-in and /sign-up.
          <ClerkProvider
            signInUrl="/sign-in"
            signUpUrl="/sign-up"
            signInFallbackRedirectUrl="/projects"
            signUpFallbackRedirectUrl="/projects"
            localization={{
              signIn: {
                start: {
                  title: "Sign in to System Design Studio",
                },
              },
            }}
          >
            {content}
          </ClerkProvider>
        )}
      </body>
    </html>
  );
}