import { createFileRoute } from "@tanstack/react-router";
import { SystemPage } from "~/features/system/system-page";

/** `/system` — Burrow's own process, clients, memory and recent failures. No URL state. */
export const Route = createFileRoute("/system")({
  head: () => ({ meta: [{ title: "System · Burrow" }] }),
  component: SystemPage,
});
