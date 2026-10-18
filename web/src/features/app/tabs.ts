/**
 * The application detail tab shell.
 *
 * Tabs are routes, so this module only *describes* them (label, href, active detection). The Spark tab is contributed by
 * the FE-Spark slice through a build-time import boundary: if `src/features/spark/tab.tsx` exists and exports
 * `sparkAppTab`, the Spark tab becomes a real link; if it does not, the tab renders disabled with an honest reason
 * instead of a broken link. No compile-time dependency on the Spark slice either way.
 */

export interface AppTabDef {
  value: string;
  label: string;
  href: string;
  /** false = the route for this tab is not part of this build */
  available: boolean;
  hint?: string;
}

interface SparkTabContribution {
  value: string;
  label: string;
  /** `$appId` is substituted with the concrete application id */
  href: string;
}

const sparkModules: Record<string, { sparkAppTab?: SparkTabContribution }> = import.meta.glob("../spark/tab.tsx", {
  eager: true,
}) as never;

const SPARK_TAB = Object.values(sparkModules)[0]?.sparkAppTab;

export function appTabs(appId: string): AppTabDef[] {
  const base = `/apps/${appId}`;
  const tabs: AppTabDef[] = [
    { value: "overview", label: "Overview", href: base, available: true },
    { value: "attempts", label: "Attempts", href: `${base}/attempts`, available: true },
    // The container-log slice owns this route; it is part of the build (routeId "/apps/$appId/logs").
    { value: "logs", label: "Logs", href: `${base}/logs`, available: true },
  ];
  tabs.push(
    SPARK_TAB
      ? { value: SPARK_TAB.value, label: SPARK_TAB.label, href: SPARK_TAB.href.replace("$appId", appId), available: true }
      : {
          value: "spark",
          label: "Spark",
          href: `${base}/spark/jobs`,
          available: false,
          hint: "The Spark UI slice is not part of this build (its routes are contributed separately).",
        },
  );
  return tabs;
}

/** Which tab is active for the current location. `attempts/$attemptId` and `containers/$containerId` both live in Attempts. */
export function activeTab(pathname: string, appId: string): string {
  const rest = pathname.slice(`/apps/${appId}`.length);
  if (rest.startsWith("/spark")) return SPARK_TAB?.value ?? "spark";
  if (rest.startsWith("/logs")) return "logs";
  if (rest.startsWith("/attempts") || rest.startsWith("/containers")) return "attempts";
  return "overview";
}
