import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { APP_ID, ATTEMPT_ID, CONTAINER_ID, readRm, RouterProvider, routerAt, serveFixtures } from "~/__tests__/route-test-utils";
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

describe("application route screens", () => {
  it("navigates through the application overview, attempts, attempt details, and container details", async () => {
    const router = routerAt(`/apps/${APP_ID}`);
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("heading", { name: "appdetail-long" })).toBeTruthy();
    expect(await screen.findByText("Application Overview")).toBeTruthy();

    await act(async () => {
      await router.navigate({ to: `/apps/${APP_ID}/attempts` as never });
    });
    const attemptsTable = await screen.findByRole("table", { name: "Application attempts" });
    fireEvent.click(attemptsTable.querySelector('[data-col="appAttemptId"] button')!);
    await waitFor(() => expect(router.state.location.search.sort).toBeTruthy());
    await act(async () => {
      await router.navigate({ to: `/apps/${APP_ID}/attempts/${ATTEMPT_ID}` as never });
    });
    expect(await screen.findByText("Attempt 1")).toBeTruthy();
    expect(await screen.findByRole("table", { name: "Attempt containers" })).toBeTruthy();

    await act(async () => {
      await router.navigate({ to: `/apps/${APP_ID}/containers/${CONTAINER_ID}` as never });
    });
    expect(await screen.findByRole("heading", { name: `Container ${CONTAINER_ID}` })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Diagnostics" })).toBeTruthy();
  });

  it("shows an attempts error and retries the ResourceManager request", async () => {
    const errorAppId = APP_ID.replace(/0001$/, "0002");
    const attemptsPath = `/api/yarn/apps/${errorAppId}/appattempts`;
    serveFixtures({
      [attemptsPath]: new Response(JSON.stringify({ error: { message: "ResourceManager unavailable" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    });
    render(<RouterProvider router={routerAt(`/apps/${errorAppId}/attempts`)} />);

    expect(await screen.findByText("Could not load the application attempts")).toBeTruthy();
    const apiFetch = vi.mocked(fetch);
    const callsBeforeRetry = apiFetch.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await waitFor(() => expect(apiFetch.mock.calls.length).toBeGreaterThan(callsBeforeRetry));
  });

  it("keeps the loading skeleton visible while attempts are unresolved", async () => {
    const loadingAppId = APP_ID.replace(/0001$/, "0003");
    const attemptsPath = `/api/yarn/apps/${loadingAppId}/appattempts`;
    let resolveAttempts: ((value: unknown) => void) | undefined;
    serveFixtures({
      [attemptsPath]: () =>
        new Promise((resolve) => {
          resolveAttempts = resolve;
        }),
    });
    const view = render(<RouterProvider router={routerAt(`/apps/${loadingAppId}/attempts`)} />);

    await waitFor(() => expect(resolveAttempts).toBeTypeOf("function"));
    expect(view.container.querySelector('[aria-busy="true"]')).toBeTruthy();
    view.unmount();
    await act(async () => {
      resolveAttempts?.(readRm("app/running/appattempts.json"));
    });
  });

  it("renders missing attempt and malformed container id states", async () => {
    const router = routerAt(`/apps/${APP_ID}/attempts/appattempt_missing`);
    render(<RouterProvider router={router} />);
    expect(await screen.findByText("Attempt appattempt_missing is not known to the ResourceManager")).toBeTruthy();

    await act(async () => {
      await router.navigate({ to: `/apps/${APP_ID}/containers/not-a-container-id` as never });
    });
    expect(await screen.findByText("Unrecognised container id")).toBeTruthy();
  });

  it("explains when the ResourceManager no longer has an application", async () => {
    const missingAppId = APP_ID.replace(/0001$/, "0005");
    serveFixtures({
      [`/api/yarn/apps/${missingAppId}`]: new Response(JSON.stringify({ error: { message: "application expired" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    });
    render(<RouterProvider router={routerAt(`/apps/${missingAppId}`)} />);

    expect(await screen.findByText(`Could not load ${missingAppId}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("keeps attempt details while showing retryable container and detail failures", async () => {
    const failedAppId = APP_ID.replace(/0001$/, "0006");
    serveFixtures({
      [`/api/yarn/apps/${failedAppId}/appattempts/${ATTEMPT_ID}/containers`]: new Response(
        JSON.stringify({ error: { message: "container list is unavailable" } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
      [`/api/yarn/apps/${failedAppId}/appattempts/${ATTEMPT_ID}`]: new Response(
        JSON.stringify({ error: { message: "attempt detail is unavailable" } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    });
    render(<RouterProvider router={routerAt(`/apps/${failedAppId}/attempts/${ATTEMPT_ID}`)} />);

    expect(await screen.findByText("Could not refresh this attempt's container list")).toBeTruthy();
    expect(await screen.findByText("Could not load the detailed attempt record")).toBeTruthy();
    for (const retry of screen.getAllByRole("button", { name: "Retry now" })) fireEvent.click(retry);
    expect(screen.getByText("Attempt 1")).toBeTruthy();
  });

  it("explains when a terminal container record has expired", async () => {
    const expiredAppId = APP_ID.replace(/0001$/, "0007");
    serveFixtures({
      [`/api/yarn/apps/${expiredAppId}/appattempts/${ATTEMPT_ID}/containers/${CONTAINER_ID}`]: new Response(
        JSON.stringify({ error: { message: "container expired" } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    });
    render(<RouterProvider router={routerAt(`/apps/${expiredAppId}/containers/${CONTAINER_ID}`)} />);

    expect(await screen.findByText("Container details are no longer available")).toBeTruthy();
  });
});
