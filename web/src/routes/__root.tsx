import { QueryClientProvider } from "@tanstack/react-query";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { startLive } from "~/api/live";
import { applyPrefsToDom, prefsStore } from "~/state/prefs";
import { isParity } from "~/state/parity";
import { createQueryClient } from "~/api/query-client";
import { AppShell } from "~/features/shell/app-shell";
import { NotFoundPage } from "~/features/shell/NotFoundPage";
import { CenteredPageState, ErrorState } from "~/ui/feedback";
import { TooltipProvider } from "~/ui/tooltip";
import "~/styles/app.css";

/** One client per page load (SPA): the query cache is the app's memory of the cluster. */
const queryClient = createQueryClient();

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "dark light" },
      { title: "Burrow" },
      {
        name: "description",
        content: "A modern, read-only view of Apache Hadoop YARN and Spark-on-YARN.",
      },
    ],
  }),
  component: () => (
    <RootDocument>
      <AppShell>
        <Outlet />
      </AppShell>
    </RootDocument>
  ),
  errorComponent: ({ error, reset }) => (
    <RootDocument>
      <AppShell>
        <CenteredPageState>
          <ErrorState
            title="This view failed to render"
            message="An unexpected problem stopped this page from loading."
            detail={error instanceof Error ? error.message : String(error)}
            hint="Retry the view. If it keeps failing, share the technical details with your administrator."
            onRetry={reset}
          />
        </CenteredPageState>
      </AppShell>
    </RootDocument>
  ),
  notFoundComponent: NotFoundPage,
});

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  // The pre-paint bootstrap and preference-store initialization set these before hydration. Mirror every attribute so
  // React preserves the chosen values instead of removing them and reapplying them after mount.
  const rootEl = typeof document === "undefined" ? undefined : document.documentElement;
  useEffect(() => {
    applyPrefsToDom(prefsStore.get());
    if (isParity()) document.documentElement.setAttribute("data-parity", "1");
    startLive(queryClient);
  }, []);
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-theme={rootEl?.getAttribute("data-theme") ?? undefined}
      data-theme-pref={rootEl?.getAttribute("data-theme-pref") ?? undefined}
      data-tz={rootEl?.getAttribute("data-tz") ?? undefined}
      data-motion={rootEl?.getAttribute("data-motion") ?? undefined}
      data-rail-collapsed={rootEl?.getAttribute("data-rail-collapsed") ?? undefined}
      data-switching={rootEl?.getAttribute("data-switching") ?? undefined}
      data-parity={rootEl?.getAttribute("data-parity") ?? undefined}
    >
      <head>
        {/* Version these URLs when the icon changes; browsers cache favicons aggressively across app reloads. */}
        <link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml" sizes="any" />
        <link rel="icon" href="/favicon.ico?v=2" type="image/x-icon" sizes="32x32" />
        {/* pre-paint theme/motion/parity bootstrap — external file so the strict CSP (script-src 'self') holds */}
        <script src="/theme-init.js" />
        <HeadContent />
      </head>
      <body>
        <TooltipProvider>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </TooltipProvider>
        <Scripts />
      </body>
    </html>
  );
}
