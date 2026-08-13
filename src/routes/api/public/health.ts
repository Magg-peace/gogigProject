// Liveness/readiness probe for external monitors (uptime checks, load balancers).
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async () => {
        const { getHealth } = await import("@/lib/metrics.server");
        const health = await getHealth();
        return Response.json(health, { status: health.status === "healthy" ? 200 : 503 });
      },
    },
  },
});
