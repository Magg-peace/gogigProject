import { RequireAuth } from "@/components/require-auth";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { UploadCloud, Loader2, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { uploadImage } from "@/lib/uploads.functions";
import { Shell, StatusBadge, type UploadStatus } from "@/components/vehicle-check";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/upload")({
  head: () => ({
    meta: [
      { title: "New Inspection — Upload a vehicle image | FieldSight AI" },
      {
        name: "description",
        content:
          "Upload a vehicle photo and get an asynchronous quality and authenticity screening: blur, low light, duplicates, screenshots, tampering and plate OCR.",
      },
      { property: "og:title", content: "FieldSight AI — Vehicle image screening pipeline" },
      {
        property: "og:description",
        content:
          "Asynchronous image quality and authenticity checks for field-collected vehicle photos.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: GuardedUpload,
});

const MAX_BYTES = 10 * 1024 * 1024;

function UploadPage() {
  const navigate = useNavigate();
  const upload = useServerFn(uploadImage);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [status, setStatus] = useState<UploadStatus>("pending");
  const [failureReason, setFailureReason] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  // Realtime: the status badge follows the row instead of being polled.
  useEffect(() => {
    if (!uploadId) return;
    const channel = supabase
      .channel(`upload-${uploadId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "uploads", filter: `id=eq.${uploadId}` },
        (payload) => {
          const row = payload.new as { status: UploadStatus; failure_reason: string | null };
          setStatus(row.status);
          setFailureReason(row.failure_reason);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [uploadId]);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      if (!["image/jpeg", "image/png"].includes(file.type)) {
        setError(`"${file.name}" is a ${file.type || "unknown"} file. Only JPEG and PNG are accepted.`);
        return;
      }
      if (file.size > MAX_BYTES) {
        setError(`"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`);
        return;
      }
      setBusy(true);
      setUploadId(null);
      setFailureReason(null);
      setStatus("pending");
      try {
        const buffer = await file.arrayBuffer();
        let binary = "";
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        const result = await upload({
          data: { filename: file.name, mimeType: file.type, base64: btoa(binary) },
        });
        setPreview(URL.createObjectURL(file));
        setUploadId(result.upload_id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
      } finally {
        setBusy(false);
      }
    },
    [upload],
  );

  return (
    <Shell
      eyebrow="New inspection"
      title="Submit a vehicle image"
      subtitle="The file is stored and queued immediately; the seven-check analysis runs out-of-band. You get an inspection ID straight away and the status below updates live."
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void handleFile(file);
          }}
          onClick={() => inputRef.current?.click()}
          className={`mt-2 cursor-pointer rounded-2xl border-2 border-dashed p-12 text-center transition-colors ${
            dragging ? "border-primary bg-primary/5" : "border-border bg-card/50 hover:border-primary/60"
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = "";
            }}
          />
          {busy ? (
            <Loader2 className="mx-auto size-8 animate-spin text-primary" />
          ) : (
            <UploadCloud className="mx-auto size-8 text-primary" />
          )}
          <p className="mt-4 font-medium">
            {busy ? "Uploading…" : "Drop a JPEG or PNG here, or click to browse"}
          </p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">max 10 MB · jpg / png only</p>
        </div>

        {error ? (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {uploadId ? (
          <div className="mt-6 rounded-xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  upload_id
                </p>
                <p className="mt-1 font-mono text-sm break-all">{uploadId}</p>
              </div>
              <StatusBadge status={status} />
            </div>
            {preview ? (
              <img
                src={preview}
                alt="Preview of the vehicle photograph selected for inspection"
                className="mt-4 max-h-64 w-full rounded-lg object-cover"
              />
            ) : null}
            {failureReason ? (
              <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {failureReason}
              </p>
            ) : null}
            <Button
              className="mt-4 w-full"
              onClick={() => navigate({ to: "/uploads/$id", params: { id: uploadId } })}
            >
              View analysis
            </Button>
          </div>
        ) : null}
      </div>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-border bg-card p-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Pipeline stages
            </p>
            <ol className="mt-4 space-y-3 text-sm">
              {[
                ["Receive", "Validated, hashed and written to object storage"],
                ["Queue", "Durable job row + trigger dispatch, non-blocking"],
                ["Analyse", "7 heuristic checks + vision OCR"],
                ["Score", "Weighted trust score and written assessment"],
              ].map(([name, detail], i) => (
                <li key={name} className="flex gap-3">
                  <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-primary/40 bg-primary/10 font-mono text-[11px] text-primary">
                    {i + 1}
                  </span>
                  <span>
                    <span className="font-medium">{name}</span>
                    <span className="block text-xs text-muted-foreground">{detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div className="rounded-2xl border border-border bg-card/60 p-5 text-xs text-muted-foreground">
            Accepted: JPEG and PNG up to 10 MB. Analysis never blocks the upload response, so a slow
            or failing worker can never lose your file.
          </div>
        </aside>
      </div>
    </Shell>
  );
}


function GuardedUpload() {
  return (
    <RequireAuth>
      <UploadPage />
    </RequireAuth>
  );
}
