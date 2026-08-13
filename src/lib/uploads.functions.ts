// Thin RPC wrappers. All logic lives in ./uploads.server.ts.
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

export const uploadImage = createServerFn({ method: "POST" })
  .inputValidator((data: { filename: string; mimeType: string; base64: string }) => data)
  .handler(async ({ data }) => {
    const { createUpload } = await import("./uploads.server");
    const origin = new URL(getRequest().url).origin;
    return createUpload({ ...data, origin });
  });

export const listUploadsFn = createServerFn({ method: "GET" })
  .inputValidator((data: { page?: number; pageSize?: number }) => data)
  .handler(async ({ data }) => {
    const { listUploads, signThumbnails } = await import("./uploads.server");
    const result = await listUploads(data.page ?? 1, data.pageSize ?? 20);
    const thumbnails = await signThumbnails(result.uploads.map((u) => u.file_path));
    return { ...result, thumbnails };
  });

export const getUploadStatusFn = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const { getStatus } = await import("./uploads.server");
    return getStatus(data.id);
  });

export const getUploadResultsFn = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const { getResults } = await import("./uploads.server");
    return getResults(data.id);
  });

export const retryUploadFn = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const { retryUpload } = await import("./uploads.server");
    const origin = new URL(getRequest().url).origin;
    return retryUpload(data.id, origin);
  });