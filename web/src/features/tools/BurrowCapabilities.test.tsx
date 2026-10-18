import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Meta } from "~/api/schemas";
import { ov } from "~/api/queries/overview";
import { BurrowCapabilities } from "./BurrowCapabilities";

const meta: Meta = {
  name: "Burrow",
  version: "0.1.0",
  now: 1_791_000_000_000,
  readOnly: true,
  rm: { urls: ["http://rm:8088"], active: "http://rm:8088", haState: "ACTIVE", hadoopVersion: "3.4.3", reachable: true },
  services: {
    sparkHistory: { configured: true, url: "http://shs:18080", reachable: true },
    jobHistory: { configured: true, url: "http://jhs:19888", reachable: false },
    timeline: { configured: true, url: "http://ats:8188", reachable: null },
  },
  features: {
    sparkLive: true,
    sparkHistory: true,
    aggregatedLogs: true,
    nodeLogs: true,
    events: true,
    kerberos: false,
  },
  yarn: { logServerUrl: null, httpPolicy: "HTTP_ONLY", scheduler: "capacity" },
};

afterEach(() => cleanup());

describe("BurrowCapabilities service status", () => {
  it("uses the shared status treatment for reachable, unreachable, and unprobed services", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
    client.setQueryData(ov.meta().queryKey, meta);
    const { container } = render(
      <QueryClientProvider client={client}>
        <BurrowCapabilities />
      </QueryClientProvider>,
    );

    for (const [label, tone] of [
      ["Reachable", "ok"],
      ["Unreachable", "fail"],
      ["Configured", "wait"],
    ] as const) {
      const pill = screen.getByText(label).closest(".burrow-pill");
      expect(pill, `${label} uses a status pill`).not.toBeNull();
      expect(pill?.className).toContain(`burrow-tone-${tone}`);
      expect(pill?.querySelector("svg"), `${label} has its status icon`).not.toBeNull();
    }
    expect(container.querySelectorAll(".burrow-pill")).toHaveLength(3);
  });
});
