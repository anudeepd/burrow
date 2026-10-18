import { createFileRoute } from "@tanstack/react-router";
import { RddDetailPage } from "~/features/spark/pages/RddDetailPage";
import { sparkSearch } from "~/features/spark/data/search";

/** `/apps/$appId/spark/storage/$rddId?sort=&dir=&cols=&attempt=` */
export const Route = createFileRoute("/apps/$appId/spark/storage/$rddId")({
  validateSearch: (s: Record<string, unknown>) => sparkSearch(s),
  component: RddDetailPage,
});
