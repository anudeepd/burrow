import { describe, expect, it } from "vitest";
import { activeTab, appTabs } from "./tabs";

describe("application tabs", () => {
  it("contributes Spark and substitutes the application id", () => {
    expect(appTabs("application_1")).toEqual([
      { value: "overview", label: "Overview", href: "/apps/application_1", available: true },
      { value: "attempts", label: "Attempts", href: "/apps/application_1/attempts", available: true },
      { value: "logs", label: "Logs", href: "/apps/application_1/logs", available: true },
      { value: "spark", label: "Spark", href: "/apps/application_1/spark/jobs", available: true },
    ]);
  });

  it("keeps Spark honestly disabled when its slice is absent", () => {
    expect(appTabs("application_2", null)[3]).toMatchObject({
      value: "spark",
      href: "/apps/application_2/spark/jobs",
      available: false,
      hint: expect.stringContaining("not part of this build"),
    });
  });

  it("maps nested detail routes to their parent tabs", () => {
    const appId = "application_1";
    expect(activeTab(`/apps/${appId}`, appId)).toBe("overview");
    expect(activeTab(`/apps/${appId}/spark/jobs`, appId)).toBe("spark");
    expect(activeTab(`/apps/${appId}/spark/jobs`, appId, null)).toBe("spark");
    expect(activeTab(`/apps/${appId}/logs`, appId)).toBe("logs");
    expect(activeTab(`/apps/${appId}/attempts/1`, appId)).toBe("attempts");
    expect(activeTab(`/apps/${appId}/containers/c1`, appId)).toBe("attempts");
    expect(activeTab("/elsewhere", appId)).toBe("overview");
  });
});
