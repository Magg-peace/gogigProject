ALTER TABLE public.analysis_results
  ADD COLUMN IF NOT EXISTS ai_summary text,
  ADD COLUMN IF NOT EXISTS trust_score integer,
  ADD COLUMN IF NOT EXISTS processing_ms integer;

CREATE TABLE IF NOT EXISTS public.processing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id uuid NOT NULL REFERENCES public.uploads(id) ON DELETE CASCADE,
  event text NOT NULL,
  message text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS processing_events_upload_id_created_at_idx
  ON public.processing_events (upload_id, created_at);

GRANT SELECT ON public.processing_events TO anon;
GRANT SELECT ON public.processing_events TO authenticated;
GRANT ALL ON public.processing_events TO service_role;

ALTER TABLE public.processing_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Processing events are publicly readable" ON public.processing_events;
CREATE POLICY "Processing events are publicly readable"
  ON public.processing_events FOR SELECT
  USING (true);