import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NodeResponseSchema, NodesResponseSchema, type Node } from "~/api/schemas";

afterEach(cleanup);

/**
 * The parity contract (docs/contracts/parity-dom.md) is verified on the REAL table. Parity mode is switched on BEFORE
 * the modules that read it are imported (the same trick the Playwright harness uses with `window.__BURROW_PARITY__`), so the
 * DataTable renders every row without virtualization and jsdom can see the required `node.derived.*` field ids.
 */
declare global {
  interface Window {
    __BURROW_PARITY__?: boolean;
  }
}
window.__BURROW_PARITY__ = true;

let DataTable: typeof import("~/ui/data-table/data-table").DataTable;
let nodeColumns: typeof import("./columns").nodeColumns;

beforeAll(async () => {
  ({ DataTable } = await import("~/ui/data-table/data-table"));
  ({ nodeColumns } = await import("./columns"));
});

// vitest runs with cwd = web/, and Vite rewrites `new URL(..., import.meta.url)` into an asset request (denied outside root)
const fixture = (name: string) => JSON.parse(readFileSync(`../fixtures/rm/nodes/${name}`, "utf8")) as unknown;

const nodes = NodesResponseSchema.parse(fixture("nodes.json")).nodes?.node ?? [];
const sampleNode = NodeResponseSchema.parse(fixture("node-127.0.0.3_8041.json")).node;

function TestTable({ data, customTypes }: { data: Node[]; customTypes: string[] }) {
  return (
    <DataTable
      data={data}
      columns={nodeColumns(customTypes)}
      getRowId={(n) => n.id}
      entityKey={(n) => n.id}
      label="Cluster nodes"
      storageKey="nodes-columns-test"
      sorting={[]}
      onSortingChange={() => {}}
      columnVisibility={{}}
      onColumnVisibilityChange={() => {}}
      defaultVisibility={{}}
      exportName="nodes"
    />
  );
}

async function renderTable(data: Node[], customTypes: string[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <TestTable data={data} customTypes={customTypes} />,
  });
  // the Address column links to the node page; the test router only needs the path to exist
  const nodeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/nodes/$nodeId", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, nodeRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const result = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await flushRouter();
  return result;
}

/** The router resolves its first match on a microtask, so the table is not in the DOM until we let it flush. */
function flushRouter(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
}

/** field id -> the element (first row of the given entity). */
function rowDatums(entity: string): Map<string, Element> {
  const row = document.querySelector(`[data-ye="${entity}"]`);
  const map = new Map<string, Element>();
  for (const el of row?.querySelectorAll("[data-yf]") ?? []) map.set(el.getAttribute("data-yf") ?? "", el);
  return map;
}

/** The GPU node type the live cluster does not configure — used to exercise the dynamic column pair. */
const gpuNode: Node = {
  ...sampleNode,
  id: "127.0.0.9:8041",
  totalResource: {
    memory: 8192,
    vCores: 8,
    resourceInformations: {
      resourceInformation: [
        { name: "memory-mb", value: 8192, tags: [] },
        { name: "vcores", value: 8, tags: [] },
        { name: "yarn.io/gpu", value: 4, tags: [] },
      ],
    },
  },
  usedResource: {
    memory: 0,
    vCores: 0,
    resourceInformations: { resourceInformation: [{ name: "yarn.io/gpu", value: 3, tags: [] }] },
  },
  availableResource: {
    memory: 0,
    vCores: 0,
    resourceInformations: { resourceInformation: [{ name: "yarn.io/gpu", value: 1, tags: [] }] },
  },
};

describe("nodes table column contract", () => {
  it("renders the allocation-tags summary verbatim (empty for the live cluster)", async () => {
    await renderTable(nodes);
    for (const n of nodes) {
      const el = rowDatums(n.id).get("node.derived.allocationTagsSummary");
      expect(el, `${n.id} must carry node.derived.allocationTagsSummary`).toBeTruthy();
      // NodesPage.java:88 prints info.getAllocationTagsSummary(); the live records show "" for every node.
      expect(el?.textContent).toBe("");
      expect(el?.getAttribute("data-yv")).toBe("");
    }
  });

  it("marks the custom-resource fields as explicitly absent when no custom type is configured", async () => {
    await renderTable(nodes);
    for (const n of nodes) {
      const datums = rowDatums(n.id);
      for (const field of ["node.derived.customResourceUsed", "node.derived.customResourceAvail"]) {
        const el = datums.get(field);
        expect(el, `${n.id} must carry ${field}`).toBeTruthy();
        expect(el?.getAttribute("data-yn")).toBe("1");
      }
    }
  });

  it("emits one Used/Avail column pair per configured custom resource type, before Version", () => {
    const labels = nodeColumns(["yarn.io/gpu"]).map((c) => c.meta?.label);
    expect(labels).toEqual([
      "Node Labels",
      "Rack",
      "Node State",
      "Node Address",
      "Node HTTP Address",
      "Last health-update",
      "Health-report",
      "Containers",
      "Allocation Tags",
      "Mem Used",
      "Mem Avail",
      "Phys Mem Used %",
      "VCores Used",
      "VCores Avail",
      "Phys VCores Used %",
      "yarn.io/gpu Used",
      "yarn.io/gpu Avail",
      "Version",
    ]);
  });

  it("prints the custom-resource values exactly as the legacy long does", async () => {
    await renderTable([gpuNode], ["yarn.io/gpu"]);
    const datums = rowDatums(gpuNode.id);
    const used = datums.get("node.derived.customResourceUsed");
    const avail = datums.get("node.derived.customResourceAvail");
    expect(used?.textContent).toBe("3");
    expect(used?.getAttribute("data-yv")).toBe("3");
    expect(avail?.textContent).toBe("1");
    expect(avail?.getAttribute("data-yv")).toBe("1");
  });
});
