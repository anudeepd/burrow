/**
 * Spark Environment — the native replacement for `/environment/` in Spark's tracking UI.
 *
 * This is the *Spark* environment (`/api/spark/{appId}/environment`), not the YARN application environment: it reports
 * the driver's JVM, system/Hadoop/Spark properties and the classpath. Every REST value is stamped inside an `Entity`
 * whose key is the property key (singleton sections use `_`); a property's `data-yv` stays the faithful `[key,value]`
 * pair while the table shows key and value in separate columns.
 */
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { fmtInt } from "~/lib/format";
import { useParity } from "~/state/parity";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum, Entity } from "~/ui/datum";
import { sp } from "../data/queries";
import { useSpark } from "../ui/context";
import { compact, matchesQuery } from "../data/search";
import { Metric, MetricStrip, PageHeader } from "../ui/PageHeader";
import { SparkFailureState, SparkLoading, SparkStaleErrorBanner } from "../ui/StateViews";
import { OptionalTooltip } from "~/ui/tooltip";

const route = getRouteApi("/apps/$appId/spark/environment");

type Pair = string[];

interface PropertyRow {
  key: string;
  pair: Pair;
}

const asPairs = (rows: readonly Pair[] | null | undefined): PropertyRow[] => (rows ?? []).map((p) => ({ key: p[0] ?? "", pair: p }));

function propertyColumns(field: string): ColDef<PropertyRow>[] {
  return [
    {
      id: "key",
      accessorKey: "key",
      size: 360,
      meta: { label: "Key", pinned: true, exportValue: (r: PropertyRow) => r.pair[0] ?? "" },
      header: "Key",
      cell: (info) => {
        const p = info.row.original.pair;
        return (
          <Datum field={field} raw={p} className="truncate font-mono text-micro" title={p[0] ?? ""}>
            {p[0] ?? ""}
          </Datum>
        );
      },
    },
    {
      id: "value",
      accessorFn: (r) => r.pair[1] ?? "",
      meta: { label: "Value", exportValue: (r: PropertyRow) => r.pair[1] ?? "" },
      header: "Value",
      cell: (info) => {
        const value = info.row.original.pair[1] ?? "";
        return (
          <OptionalTooltip label={value}>
            <span className="break-all text-small text-ink-2">{value}</span>
          </OptionalTooltip>
        );
      },
    },
  ];
}

/** Collapsible pane. Open by default; parity forces every pane open so the crawl sees all data. */
function Pane({
  title,
  count,
  note,
  toolbar,
  children,
}: {
  title: string;
  count?: string;
  note?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  const parity = useParity();
  const [open, setOpen] = useState(true);
  const isOpen = parity || open;
  return (
    <section className="rounded-lg border border-seam bg-fabric">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={isOpen}
          className="burrow-touch-target flex min-h-11 min-w-11 items-center gap-1.5 text-body font-semibold text-ink sm:min-h-0 sm:min-w-0"
        >
          {isOpen ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
          {title}
        </button>
        {count && <span className="text-small text-ink-4 tnum">{count}</span>}
        {note && <span className="text-small text-ink-4">{note}</span>}
        {toolbar && <span className="ml-auto flex flex-wrap items-center gap-2">{toolbar}</span>}
      </div>
      {isOpen && (
        <div className="border-t border-seam-soft p-3">
          <Entity id="_">{children}</Entity>
        </div>
      )}
    </section>
  );
}

function PropertyPane({
  title,
  field,
  rows,
  urlQ,
  setUrlQ,
}: {
  title: string;
  field: string;
  rows: PropertyRow[];
  urlQ?: string;
  setUrlQ?: (v: string) => void;
}) {
  const [localQ, setLocalQ] = useState("");
  const q = urlQ ?? localQ;
  const setQ = setUrlQ ?? setLocalQ;
  const [sorting, setSorting] = useState<SortingState>([]);
  const [visibility, setVisibility] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => (q ? rows.filter((r) => matchesQuery(r.pair, q)) : rows), [rows, q]);
  const columns = useMemo(() => propertyColumns(field), [field]);

  return (
    <Pane
      title={title}
      count={filtered.length === rows.length ? `${fmtInt(rows.length)} entries` : `${fmtInt(filtered.length)} of ${fmtInt(rows.length)}`}
      toolbar={
        <label className="flex items-center gap-1.5 text-small text-ink-3">
          <span className="sr-only">Filter {title}</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter key or value…"
            className="h-(--ctl-h) w-52 rounded-md border border-seam-strong bg-well px-2 text-body text-ink placeholder:text-ink-4"
          />
        </label>
      }
    >
      <div className="flex h-72 min-h-0 flex-col">
        <DataTable<PropertyRow>
          data={filtered}
          columns={columns}
          getRowId={(r) => r.key}
          entityKey={(r) => r.key}
          label={title}
          storageKey={`spark-env-${field}`}
          sorting={sorting}
          onSortingChange={setSorting}
          columnVisibility={visibility}
          onColumnVisibilityChange={setVisibility}
          defaultVisibility={{}}
          totalCount={rows.length}
          exportName={`spark-env-${field}`}
          empty={<span className="text-small text-ink-3">Spark returned no entries for {title}.</span>}
        />
      </div>
    </Pane>
  );
}

interface ResourceProfile {
  id?: number;
  executorResources?: Record<string, { amount?: number; discoveryScript?: string; vendor?: string; resourceName?: string }>;
  taskResources?: Record<string, { amount?: number; resourceName?: string }>;
}

export function EnvironmentPage() {
  const { appId } = route.useParams();
  const { attempt } = useSpark();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const q = typeof search.q === "string" ? search.q : "";
  const qEnv = useQuery(sp.environment(appId, attempt));
  const env = qEnv.data;

  const sparkProperties = useMemo(() => asPairs(env?.sparkProperties), [env?.sparkProperties]);
  const systemProperties = useMemo(() => asPairs(env?.systemProperties), [env?.systemProperties]);
  const hadoopProperties = useMemo(() => asPairs(env?.hadoopProperties), [env?.hadoopProperties]);
  const metricsProperties = useMemo(() => asPairs(env?.metricsProperties), [env?.metricsProperties]);
  const classpath = useMemo(() => (env?.classpathEntries ?? []).map((entry, i) => ({ i, entry })), [env?.classpathEntries]);
  const profiles = useMemo(() => (env?.resourceProfiles ?? []) as ResourceProfile[], [env?.resourceProfiles]);
  const [classpathSorting, setClasspathSorting] = useState<SortingState>([]);
  const [classpathVisibility, setClasspathVisibility] = useState<Record<string, boolean>>({});

  const patch = (p: Record<string, unknown>) => void navigate({ search: (prev) => compact({ ...prev, ...p }) });

  const classpathColumns = useMemo<ColDef<{ i: number; entry: string[] }>[]>(
    () => [
      {
        id: "path",
        accessorFn: (r) => r.entry.slice(0, -1).join("/"),
        meta: { label: "Classpath entry", pinned: true },
        header: "Classpath entry",
        cell: (info) => {
          const e = info.row.original.entry;
          return (
            <Datum field="spark.env.classpathEntries" raw={e} className="truncate font-mono text-micro" title={e.slice(0, -1).join("/")}>
              {e.slice(0, -1).join("/")}
            </Datum>
          );
        },
      },
      {
        id: "kind",
        accessorFn: (r) => r.entry[r.entry.length - 1] ?? "",
        meta: { label: "Kind", exportValue: (r: { i: number; entry: string[] }) => r.entry[r.entry.length - 1] ?? "" },
        header: "Kind",
        cell: (info) => {
          const e = info.row.original.entry;
          return (
            <Datum field="spark.env.classpathEntries" raw={e} className="text-small text-ink-3">
              {e[e.length - 1] ?? ""}
            </Datum>
          );
        },
      },
    ],
    [],
  );

  if (qEnv.isPending) return <SparkLoading rows={10} cols={2} />;
  if (qEnv.error && !env)
    return <SparkFailureState error={qEnv.error} subject="the Spark environment" onRetry={() => void qEnv.refetch()} />;

  return (
    <div className="flex flex-col gap-4 pb-6">
      <PageHeader title="Environment" hideTitle />
      {qEnv.error && <SparkStaleErrorBanner error={qEnv.error} subject="the Spark environment" onRetry={() => void qEnv.refetch()} />}

      <Entity id="_">
        <MetricStrip>
          <Metric label="Java version">
            <Datum field="spark.env.runtime.javaVersion" raw={env?.runtime?.javaVersion} />
          </Metric>
          <Metric label="Java home" hint={env?.runtime?.javaHome ?? undefined}>
            <Datum
              field="spark.env.runtime.javaHome"
              raw={env?.runtime?.javaHome}
              className="block truncate font-mono text-micro"
              title={env?.runtime?.javaHome ?? undefined}
            />
          </Metric>
          <Metric label="Scala version">
            <Datum field="spark.env.runtime.scalaVersion" raw={env?.runtime?.scalaVersion} />
          </Metric>
        </MetricStrip>
      </Entity>

      <PropertyPane
        title="Spark Properties"
        field="spark.env.sparkProperties"
        rows={sparkProperties}
        urlQ={q}
        setUrlQ={(v) => patch({ q: v || undefined })}
      />

      <PropertyPane title="System Properties" field="spark.env.systemProperties" rows={systemProperties} />
      <PropertyPane title="Hadoop Properties" field="spark.env.hadoopProperties" rows={hadoopProperties} />
      <PropertyPane title="Metrics Properties" field="spark.env.metricsProperties" rows={metricsProperties} />

      <Pane title="Classpath Entries" count={`${fmtInt(classpath.length)} entries`}>
        <div className="flex h-72 min-h-0 flex-col">
          <DataTable<{ i: number; entry: string[] }>
            data={classpath}
            columns={classpathColumns}
            getRowId={(r) => String(r.i)}
            entityKey={(r) => String(r.i)}
            label="Classpath entries"
            storageKey="spark-env-classpath"
            sorting={classpathSorting}
            onSortingChange={setClasspathSorting}
            columnVisibility={classpathVisibility}
            onColumnVisibilityChange={setClasspathVisibility}
            defaultVisibility={{ kind: true }}
            totalCount={classpath.length}
            exportName="spark-env-classpath"
            empty={<span className="text-small text-ink-3">Spark returned no classpath entries.</span>}
          />
        </div>
      </Pane>

      <Pane title="Resource Profiles" count={`${fmtInt(profiles.length)} ${profiles.length === 1 ? "profile" : "profiles"}`}>
        {profiles.length === 0 ? (
          <p className="text-small text-ink-3">No resource profiles reported.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {profiles.map((p, i) => {
              const exec = p.executorResources ?? {};
              const task = p.taskResources ?? {};
              return (
                <Entity key={p.id ?? i} id={String(p.id ?? i)} className="min-w-56 rounded-md border border-seam bg-well p-2.5">
                  <div className="mb-1 text-small font-semibold text-ink">
                    Profile <Datum field="spark.env.resourceProfiles.id" raw={p.id} fmt="int" />
                  </div>
                  <MetricStrip>
                    <Metric label="Cores">
                      <Datum field="spark.env.resourceProfiles.executorResources.cores.amount" raw={exec.cores?.amount} fmt="int" />
                    </Metric>
                    <Metric label="Memory (MiB)">
                      <Datum field="spark.env.resourceProfiles.executorResources.memory.amount" raw={exec.memory?.amount} fmt="int" />
                    </Metric>
                    <Metric label="Off-heap (MiB)">
                      <Datum field="spark.env.resourceProfiles.executorResources.offHeap.amount" raw={exec.offHeap?.amount} fmt="int" />
                    </Metric>
                    <Metric label="Task CPUs">
                      <Datum field="spark.env.resourceProfiles.taskResources.cpus.amount" raw={task.cpus?.amount} fmt="int" />
                    </Metric>
                  </MetricStrip>
                  {Object.entries(exec)
                    .filter(([name]) => !["cores", "memory", "offHeap"].includes(name))
                    .map(([name, resource]) => (
                      <div key={name} className="mt-2 text-small">
                        <span className="font-mono text-ink-3">Executor {name}: </span>
                        <Datum field={`spark.env.resourceProfiles.executorResources.${name}.amount`} raw={resource.amount} />
                        {resource.vendor && (
                          <Datum
                            field={`spark.env.resourceProfiles.executorResources.${name}.vendor`}
                            raw={resource.vendor}
                            className="ml-2"
                          />
                        )}
                        {resource.discoveryScript && (
                          <Datum
                            field={`spark.env.resourceProfiles.executorResources.${name}.discoveryScript`}
                            raw={resource.discoveryScript}
                            className="mt-1 block break-all font-mono text-micro"
                          />
                        )}
                      </div>
                    ))}
                  {Object.entries(task)
                    .filter(([name]) => name !== "cpus")
                    .map(([name, resource]) => (
                      <div key={name} className="mt-2 text-small">
                        <span className="font-mono text-ink-3">Task {name}: </span>
                        <Datum field={`spark.env.resourceProfiles.taskResources.${name}.amount`} raw={resource.amount} />
                      </div>
                    ))}
                </Entity>
              );
            })}
          </div>
        )}
      </Pane>
    </div>
  );
}
