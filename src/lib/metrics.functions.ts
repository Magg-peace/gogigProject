// Thin RPC wrappers over the observability read-model.
import { createServerFn } from "@tanstack/react-start";

export const getAnalyticsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { getAnalytics } = await import("./metrics.server");
  return getAnalytics();
});

export const getHealthFn = createServerFn({ method: "GET" }).handler(async () => {
  const { getHealth } = await import("./metrics.server");
  return getHealth();
});

export const getTimelineFn = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const { getTimeline } = await import("./metrics.server");
    return getTimeline(data.id);
  });

export const getQueueOpsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { getQueueOps } = await import("./metrics.server");
  return getQueueOps();
});

export const replayFailedJobsFn = createServerFn({ method: "POST" }).handler(async () => {
  const { getRequest } = await import("@tanstack/react-start/server");
  const { replayFailedJobs } = await import("./metrics.server");
  const origin = new URL(getRequest().url).origin;
  return replayFailedJobs(origin);
});
