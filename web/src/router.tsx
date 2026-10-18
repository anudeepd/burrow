import { createRouter } from "@tanstack/react-router";
import { NotFoundPage } from "./features/shell/NotFoundPage";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const cspNonce =
    typeof document === "undefined"
      ? "__BURROW_CSP_NONCE__"
      : document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.content;

  return createRouter({
    routeTree,
    defaultNotFoundComponent: NotFoundPage,
    ssr: { nonce: cspNonce },
    scrollRestoration: true,
    // Pages own their scrollers. Reset the active page on a fresh route, while TanStack keeps each history entry's own
    // offset available for Back/Forward restoration.
    scrollToTopSelectors: [".burrow-page-scroll"],
    defaultPreload: "intent",
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
