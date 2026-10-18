/**
 * Upstream URL rewriting. The RM advertises itself by hostname and NodeManagers advertise their own node addresses;
 * a browser talking to Burrow over a tunnel cannot resolve either, so outbound links must be re-pointed at the
 * base the operator configured — while the raw upstream value stays untouched for the parity harness.
 */
import { describe, expect, it } from "vitest";
import { rewriteUpstreamUrl } from "~/lib/upstream-url";

const bases = {
  rm: "http://127.0.0.1:8088",
  sparkHistory: "http://127.0.0.1:18080",
  jhs: "http://127.0.0.1:19888",
};

describe("rewriteUpstreamUrl", () => {
  it("rewrites the RM's self-advertised hostname to the configured base", () => {
    // Exactly what the live RM answered for a running app (cluster hostname, not the configured base).
    const r = rewriteUpstreamUrl("http://smadayma:8088/proxy/application_1_0001/", bases);
    expect(r.kind).toBe("rm-proxy");
    expect(r.href).toBe("http://127.0.0.1:8088/proxy/application_1_0001/");
    expect(r.raw).toBe("http://smadayma:8088/proxy/application_1_0001/");
    expect(r.internal).toBe(false);
  });

  it("rewrites RM webapp pages (raw YARN UI links) to the configured base", () => {
    const r = rewriteUpstreamUrl("http://smadayma:8088/cluster/app/application_1_0001", bases);
    expect(r.href).toBe("http://127.0.0.1:8088/cluster/app/application_1_0001");
    expect(r.kind).toBe("rm");
  });

  it("rewrites aggregated-log links to the configured JobHistory base", () => {
    const r = rewriteUpstreamUrl("http://cluster-host:19888/jobhistory/logs/127.0.0.4:8041/c1/c1/alice", bases);
    expect(r.kind).toBe("jhs");
    expect(r.href).toBe("http://127.0.0.1:19888/jobhistory/logs/127.0.0.4:8041/c1/c1/alice");
  });

  it("flags NodeManager HTML as cluster-internal instead of pretending it will open", () => {
    const r = rewriteUpstreamUrl("http://127.0.0.4:8042/node/containerlogs/container_1_0001_01_000001/alice", bases);
    expect(r.internal).toBe(true);
    expect(r.kind).toBe("node-manager");
    // unchanged: Burrow exposes NM REST, not the NM UI, so there is no reachable base to rewrite to
    expect(r.href).toBe("http://127.0.0.4:8042/node/containerlogs/container_1_0001_01_000001/alice");
  });

  it("leaves a Spark History URL on its configured base and classifies it", () => {
    const r = rewriteUpstreamUrl("http://127.0.0.1:18080/history/application_1_0001/1/jobs/", bases);
    expect(r.kind).toBe("spark-history");
    expect(r.href).toBe("http://127.0.0.1:18080/history/application_1_0001/1/jobs/");
  });

  it("never rewrites an unrelated host", () => {
    const r = rewriteUpstreamUrl("https://example.com/somewhere", bases);
    expect(r.kind).toBe("other");
    expect(r.href).toBe("https://example.com/somewhere");
  });

  it("is total: null, empty and non-URL values pass through", () => {
    expect(rewriteUpstreamUrl(null, bases).href).toBe("");
    expect(rewriteUpstreamUrl(undefined, bases).raw).toBe("");
    expect(rewriteUpstreamUrl("not a url", bases).href).toBe("not a url");
    expect(rewriteUpstreamUrl("/relative/path", bases).kind).toBe("other");
  });

  it("preserves query and hash when rewriting", () => {
    const r = rewriteUpstreamUrl("http://rm-host:8088/cluster/apps?states=RUNNING#top", bases);
    expect(r.href).toBe("http://127.0.0.1:8088/cluster/apps?states=RUNNING#top");
  });

  it("still classifies RM URLs when no bases are configured", () => {
    const r = rewriteUpstreamUrl("http://rm-host:8088/proxy/application_1_0001/", {});
    expect(r.kind).toBe("rm-proxy");
    expect(r.href).toBe("http://rm-host:8088/proxy/application_1_0001/");
  });
});
