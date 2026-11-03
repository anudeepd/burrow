import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useUpstreamBases } from "~/lib/upstream-url";

function mountWithMeta(meta?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  if (meta !== undefined) client.setQueryData(["meta"], meta);
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useUpstreamBases(), { wrapper });
}

describe("useUpstreamBases", () => {
  it("returns null bases before metadata is available", () => {
    const { result } = mountWithMeta();
    expect(result.current).toEqual({ rm: null, sparkHistory: null, jhs: null });
  });

  it("reads the daemon bases from metadata", () => {
    const { result } = mountWithMeta({
      rm: { active: "http://rm:8088" },
      services: {
        sparkHistory: { url: "http://spark:18080" },
        jobHistory: { url: "http://jhs:19888" },
      },
    });
    expect(result.current).toEqual({
      rm: "http://rm:8088",
      sparkHistory: "http://spark:18080",
      jhs: "http://jhs:19888",
    });
  });
});
