// Server-only implementation behind the upload/status/list/retry API surface.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enqueueAnalysis, recordEvent } from "./pipeline.server";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MIME = ["image/jpeg", "image/png"] as const;

export type UploadRow = {
  id: string;
  file_path: string;
  original_filename: string;
  file_size_bytes: number;
  mime_type: string;
  status: "pending" | "processing" | "completed" | "failed";
  failure_reason: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
};

export class ValidationError extends Error {}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function createUpload(input: {
  filename: string;
  mimeType: string;
  base64: string;
  origin: string;
}) {
  if (!ALLOWED_MIME.includes(input.mimeType as (typeof ALLOWED_MIME)[number])) {
    throw new ValidationError(
      `Unsupported file type "${input.mimeType}". Only JPEG and PNG images are accepted.`,
    );
  }
  const bytes = base64ToBytes(input.base64);
  if (bytes.byteLength === 0) throw new ValidationError("The uploaded file is empty.");
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new ValidationError(
      `File is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB.`,
    );
  }

  const id = crypto.randomUUID();
  const extension = input.mimeType === "image/png" ? "png" : "jpg";
  const filePath = `${id}.${extension}`;

  const { error: storageError } = await supabaseAdmin.storage
    .from("vehicle-images")
    .upload(filePath, bytes, { contentType: input.mimeType, upsert: false });
  if (storageError) throw new Error(`Storage upload failed: ${storageError.message}`);
  console.log(`[upload] stored ${filePath} (${bytes.byteLength} bytes)`);

  const { data, error } = await supabaseAdmin
    .from("uploads")
    .insert({
      id,
      file_path: filePath,
      original_filename: input.filename.slice(0, 255),
      file_size_bytes: bytes.byteLength,
      mime_type: input.mimeType,
      status: "pending",
    })
    .select()
    .single();
  if (error) {
    // Compensating cleanup so Storage does not accumulate orphans when the DB
    // write fails. Not transactional — see README failure-handling notes.
    await supabaseAdmin.storage.from("vehicle-images").remove([filePath]);
    throw new Error(`Database insert failed: ${error.message}`);
  }

  await recordEvent(supabaseAdmin, id, "UPLOAD_RECEIVED", `Received ${input.filename} (${(bytes.byteLength / 1024).toFixed(0)} KB) and stored it in object storage.`);
  await recordEvent(supabaseAdmin, id, "METADATA_STORED", "Inspection record created with file metadata.");
  await recordEvent(supabaseAdmin, id, "JOB_QUEUED", "Inspection queued for asynchronous analysis.");

  // The DB trigger is the primary enqueue path. This direct dispatch is a
  // belt-and-braces fallback for environments where pg_net cannot reach the app
  // (e.g. a local dev host). processUpload() is idempotent per upload row.
  void enqueueAnalysis(id, input.origin);

  return { upload_id: id, status: data.status as string, file_path: filePath };
}

export async function listUploads(page: number, pageSize: number) {
  const from = (page - 1) * pageSize;
  const { data, error, count } = await supabaseAdmin
    .from("uploads")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) throw new Error(error.message);
  return { uploads: (data ?? []) as UploadRow[], total: count ?? 0, page, page_size: pageSize };
}

export async function getStatus(uploadId: string) {
  const { data, error } = await supabaseAdmin
    .from("uploads")
    .select("id, status, failure_reason, retry_count, created_at, updated_at")
    .eq("id", uploadId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new ValidationError("Upload not found.");
  return data;
}

export async function getResults(uploadId: string) {
  const { data: upload, error } = await supabaseAdmin
    .from("uploads")
    .select("*")
    .eq("id", uploadId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!upload) throw new ValidationError("Upload not found.");

  const { data: signed } = await supabaseAdmin.storage
    .from("vehicle-images")
    .createSignedUrl(upload.file_path as string, 3600);

  if (upload.status !== "completed") {
    return { upload: upload as UploadRow, result: null, image_url: signed?.signedUrl ?? null };
  }
  const { data: result } = await supabaseAdmin
    .from("analysis_results")
    .select("*")
    .eq("upload_id", uploadId)
    .maybeSingle();
  return { upload: upload as UploadRow, result, image_url: signed?.signedUrl ?? null };
}

export async function retryUpload(uploadId: string, origin: string) {
  const { data, error } = await supabaseAdmin
    .from("uploads")
    .select("id, status")
    .eq("id", uploadId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new ValidationError("Upload not found.");
  if (data.status === "processing") {
    throw new ValidationError("This upload is already being processed.");
  }
  await supabaseAdmin
    .from("uploads")
    .update({ status: "pending", failure_reason: null })
    .eq("id", uploadId);
  await recordEvent(supabaseAdmin, uploadId, "JOB_REQUEUED", "Manual retry requested; inspection re-queued.");
  void enqueueAnalysis(uploadId, origin);
  return { upload_id: uploadId, status: "pending" as const };
}

export async function signThumbnails(paths: string[]) {
  if (!paths.length) return {} as Record<string, string>;
  const { data } = await supabaseAdmin.storage
    .from("vehicle-images")
    .createSignedUrls(paths, 3600);
  const map: Record<string, string> = {};
  for (const item of data ?? []) {
    if (item.path && item.signedUrl) map[item.path] = item.signedUrl;
  }
  return map;
}