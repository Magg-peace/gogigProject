// The async analysis worker endpoint.
//
// Called by the Postgres AFTER INSERT trigger on public.uploads (via pg_net), and
// by the manual retry server function. Public prefix because pg_net calls it from
// outside the app session; it only accepts an upload_id that must already exist,
// and performs no destructive action beyond re-running analysis on that row.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/analyze-image")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let uploadId: string | undefined;
        try {
          const body = (await request.json()) as
            | { upload_id?: string; record?: { id?: string } }
            | null;
          // Database Webhook payloads arrive as { type, table, record }, direct
          // invocations as { upload_id }. Accept both.
          uploadId = body?.upload_id ?? body?.record?.id;
        } catch {
          uploadId = undefined;
        }
        if (!uploadId) {
          return Response.json({ error: "upload_id is required" }, { status: 400 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { processUpload } = await import("@/lib/pipeline.server");
        const result = await processUpload(supabaseAdmin, uploadId);
        return Response.json(result, { status: result.ok ? 200 : 500 });
      },
    },
  },
});