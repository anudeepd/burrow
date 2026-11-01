import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, render, waitFor } from "@testing-library/react";
import { APP_ID, RouterProvider, routerAt, serveFixtures } from "~/__tests__/route-test-utils";
import { parityStore } from "~/state/parity";

window.__BURROW_PARITY__ = true;

beforeEach(() => {
  parityStore.setState(() => ({ enabled: true }));
  serveFixtures();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  parityStore.setState(() => ({ enabled: false }));
});

describe("Spark route screens", () => {
  it("mounts every Spark list route and its job, stage, SQL, and RDD detail routes", { timeout: 30_000 }, async () => {
    const router = routerAt(`/apps/${APP_ID}/spark`);
    render(<RouterProvider router={router} />);
    const navigate = async (path: string) =>
      act(async () => {
        await router.navigate({ to: path as never });
      });

    const pagePaths = [
      ["Jobs", "jobs"],
      ["Stages", "stages"],
      ["Executors", "executors"],
      ["Storage", "storage"],
      ["Environment", "environment"],
      ["SQL", "sql"],
      ["Streaming", "streaming"],
      ["Timeline", "timeline"],
    ] as const;
    await waitFor(() => expect(router.state.location.pathname).toBe(`/apps/${APP_ID}/spark/jobs`));
    for (const [label, path] of pagePaths) {
      await navigate(`/apps/${APP_ID}/spark/${path}`);
      await waitFor(() => expect(screen.getByRole("link", { name: label }).getAttribute("aria-current")).toBe("page"));
      expect(screen.getByRole("navigation", { name: "Spark pages" })).toBeTruthy();
    }

    await navigate(`/apps/${APP_ID}/spark/jobs/0`);
    expect(await screen.findByRole("heading", { name: /Job 0/ })).toBeTruthy();

    await navigate(`/apps/${APP_ID}/spark/stages/0/0`);
    expect(await screen.findByRole("heading", { name: /Stage 0/ })).toBeTruthy();

    await navigate(`/apps/${APP_ID}/spark/sql/0`);
    expect(await screen.findByRole("heading", { name: /SQL execution 0/ })).toBeTruthy();

    await navigate(`/apps/${APP_ID}/spark/storage/52`);
    expect(await screen.findByRole("heading", { name: /RDD 52/ })).toBeTruthy();
  });

  it("keeps historical Spark routes available after the ResourceManager expires the YARN app", async () => {
    const expiredAppId = APP_ID.replace(/0001$/, "0004");
    serveFixtures({
      [`/api/yarn/apps/${expiredAppId}`]: new Response(JSON.stringify({ error: { message: "application expired" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    });
    const router = routerAt(`/apps/${expiredAppId}/spark`);
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("heading", { name: "burrow-dstream" })).toBeTruthy();
    expect(await screen.findByText("Spark History Server")).toBeTruthy();
  });
});
