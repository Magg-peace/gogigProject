// Machine-readable pipeline metrics. Read-only aggregates, no PII.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/metrics")({
  server: {
    handlers: {
      GET: async () => {
        const { getAnalytics } = await import("@/lib/metrics.server");
        return Response.json(await getAnalytics());
      },
    },
  },
});
