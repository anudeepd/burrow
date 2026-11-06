import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_ID, ATTEMPT_ID, q, queryClient, readRm, RouterProvider, routerAt, setupRouteCoverage } from "./app-route-coverage.setup";

setupRouteCoverage();

beforeEach(() => {
  vi.spyOn(Element.prototype, "animate").mockImplementation(
    () => ({ playState: "finished", finished: Promise.resolve(), cancel: vi.fn() }) as unknown as Animation,
  );
});

type RouteQueryOptions =
  | ReturnType<typeof q.app>
  | ReturnType<typeof q.appAttempts>
  | ReturnType<typeof q.appContainers>
  | ReturnType<typeof q.appAttemptDetail>;

function seedData(options: RouteQueryOptions, data: unknown) {
  queryClient.setQueryDefaults(options.queryKey, { enabled: false });
  queryClient.setQueryData(options.queryKey, data as never);
}

function seedRawError(options: RouteQueryOptions, error: unknown, data?: unknown) {
  queryClient.setQueryDefaults(options.queryKey, { enabled: false });
  const query = queryClient.getQueryCache().build(queryClient, options as never);
  query.setState({
    ...query.state,
    data: data as never,
    dataUpdatedAt: data === undefined ? 0 : Date.now(),
    status: "error",
    error: error as Error,
    errorUpdatedAt: Date.now(),
    fetchStatus: "idle",
  } as never);
}

describe("route recovery edge cases", () => {
  it("shows a fallback when an application query error is not an Error object", async () => {
    const appId = APP_ID.replace(/0001$/, "0101");
    seedRawError(q.app(appId), "raw query error");
    render(<RouterProvider router={routerAt(`/apps/${appId}`)} />);
    expect(await screen.findByText("The ResourceManager did not return the application.")).toBeTruthy();
  });

  it("shows a fallback for a raw attempts error and pluralizes an empty attempts list", async () => {
    const appId = APP_ID.replace(/0001$/, "0102");
    seedData(q.app(appId), readRm("app/running/app.json"));
    seedRawError(q.appAttempts(appId), "raw attempts error");
    const errorView = render(<RouterProvider router={routerAt(`/apps/${appId}/attempts`)} />);
    expect(await screen.findByText("The RM did not return an attempts payload.")).toBeTruthy();
    errorView.unmount();

    const emptyAppId = APP_ID.replace(/0001$/, "0103");
    seedData(q.app(emptyAppId), readRm("app/running/app.json"));
    seedData(q.appAttempts(emptyAppId), { appAttempts: { appAttempt: [] } });
    render(<RouterProvider router={routerAt(`/apps/${emptyAppId}/attempts`)} />);
    expect(await screen.findByText("0 attempts")).toBeTruthy();
  });

  it("shows a raw missing-attempts error on the overview and its detail child", async () => {
    const appId = APP_ID.replace(/0001$/, "0107");
    seedData(q.app(appId), readRm("app/running/app.json"));
    seedRawError(q.appAttempts(appId), "raw missing attempts");
    render(<RouterProvider router={routerAt(`/apps/${appId}/attempts/${ATTEMPT_ID}`)} />);
    expect(await screen.findAllByText("raw missing attempts")).toHaveLength(2);
  });

  it("shows raw stale errors for an attempt, its containers, and its detail record", async () => {
    const appId = APP_ID.replace(/0001$/, "0104");
    seedData(q.app(appId), readRm("app/running/app.json"));
    seedRawError(q.appAttempts(appId), "raw attempt-list error", readRm("app/running/appattempts.json"));
    seedRawError(q.appContainers(appId, ATTEMPT_ID), "raw container error");
    seedRawError(q.appAttemptDetail(appId, ATTEMPT_ID), "raw detail error");

    render(<RouterProvider router={routerAt(`/apps/${appId}/attempts/${ATTEMPT_ID}`)} />);
    expect(await screen.findAllByText("raw attempt-list error")).toHaveLength(2);
    expect(await screen.findByText("raw container error")).toBeTruthy();
    expect(await screen.findByText("raw detail error")).toBeTruthy();
  });

  it("marks an empty container response unavailable for a finished attempt", async () => {
    const appId = APP_ID.replace(/0001$/, "0105");
    const appPayload = readRm("app/finished/app.json") as { app: Record<string, unknown> };
    const attemptPayload = readRm("app/running/appattempts.json") as {
      appAttempts: { appAttempt: Array<Record<string, unknown>> };
    };
    const attempt = attemptPayload.appAttempts.appAttempt[0]!;
    seedData(q.app(appId), { app: { ...appPayload.app, id: appId } });
    seedData(q.appAttempts(appId), {
      appAttempts: {
        appAttempt: [{ ...attempt, appAttemptId: ATTEMPT_ID, appAttemptState: "FINISHED", finishedTime: Date.now() }],
      },
    });
    seedData(q.appContainers(appId, ATTEMPT_ID), { containers: { container: [] } });
    seedData(q.appAttemptDetail(appId, ATTEMPT_ID), { appAttemptId: ATTEMPT_ID, appAttemptState: "FINISHED" });

    render(<RouterProvider router={routerAt(`/apps/${appId}/attempts/${ATTEMPT_ID}`)} />);
    expect(await screen.findByText("Container records are no longer retained for this finished attempt.")).toBeTruthy();
  });

  it("uses the newest attempt when the application has no tracking URL", async () => {
    const appId = APP_ID.replace(/0001$/, "0106");
    const appPayload = readRm("app/running/app.json") as { app: Record<string, unknown> };
    const app: Record<string, unknown> = { ...appPayload.app, id: appId };
    delete app.trackingUrl;
    const attemptsPayload = readRm("app/running/appattempts.json") as {
      appAttempts: { appAttempt: Array<Record<string, unknown>> };
    };
    const base = attemptsPayload.appAttempts.appAttempt[0]!;
    const attempt = (id: number) => ({
      ...base,
      id,
      appAttemptId: ATTEMPT_ID.replace(/000001$/, String(id).padStart(6, "0")),
    });
    seedData(q.app(appId), { app });
    seedData(q.appAttempts(appId), { appAttempts: { appAttempt: [attempt(1), attempt(3), attempt(2)] } });

    render(<RouterProvider router={routerAt(`/apps/${appId}`)} />);
    expect(await screen.findByRole("link", { name: "ApplicationMaster" })).toBeTruthy();
  });
});
