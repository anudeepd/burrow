/**
 * Contribution point for the application detail tab strip (owner: FE-AppDetail).
 * They glob `../spark/tab.tsx` and read exactly this named export; nothing else is coupled.
 */
export const sparkAppTab = { value: "spark", label: "Spark", href: "/apps/$appId/spark/jobs" };
