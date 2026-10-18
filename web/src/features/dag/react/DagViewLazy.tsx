/**
 * Lazily loaded DAG view.
 *
 * `~/features/dag` pulls in ELK (~1.6 MB uncompressed) and the renderer; a route that merely *links* to a DAG must not
 * pay for that. `DagViewLazy` keeps the engine in its own chunk and only starts fetching it when the component is
 * rendered (or `preloadDagView()` is called, e.g. on an intent-to-navigate hover).
 */
import { Suspense, lazy, useMemo } from "react";
import type { DagViewProps } from "./DagView";
import { DagLoadingPanel } from "./chrome";

let preloaded: Promise<unknown> | null = null;

/**
 * Warm the engine chunk (one dynamic import; the layout client and `dag.css` come along because `DagView` imports
 * them). Safe to call repeatedly — the module promise is cached, so hovering a DAG link only ever downloads once.
 */
export function preloadDagView(): Promise<unknown> {
  // Code splitting is the whole point here: a static import would pull ELK into every route's bundle, so the specifier
  // must stay dynamic.
  if (!preloaded) preloaded = import("./DagView");
  return preloaded;
}

const LazyDag = lazy(async () => {
  const mod = (await preloadDagView()) as { DagView: React.ComponentType<DagViewProps> };
  return { default: mod.DagView };
});

export function DagViewLazy(props: DagViewProps) {
  const fallbackHeight = props.height ?? 420;
  const style = useMemo(
    () => ({
      height: fallbackHeight,
      backgroundImage: "radial-gradient(var(--seam-soft) 1px, transparent 1px)",
      backgroundSize: "22px 22px",
      backgroundPosition: "0 0",
    }),
    [fallbackHeight],
  );
  const totals =
    "stages" in props.dag
      ? props.dag.stages.reduce((sum, stage) => ({ nodes: sum.nodes + stage.nodes.length, edges: sum.edges + stage.edges.length }), {
          nodes: 0,
          edges: props.dag.edges.length,
        })
      : { nodes: props.dag.nodes.length, edges: props.dag.edges.length };
  const detail = `${totals.nodes} nodes · ${totals.edges} edges`;
  return (
    <Suspense
      fallback={
        <div className="burrow-dag relative isolate overflow-hidden bg-ground" style={style}>
          <DagLoadingPanel detail={detail} />
        </div>
      }
    >
      <LazyDag {...props} />
    </Suspense>
  );
}
