CREATE TABLE public.uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_path text NOT NULL,
  original_filename text NOT NULL,
  file_size_bytes integer NOT NULL,
  mime_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  failure_reason text,
  retry_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.analysis_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id uuid NOT NULL REFERENCES public.uploads(id) ON DELETE CASCADE,
  is_blurry boolean,
  blur_score numeric,
  brightness_score numeric,
  is_low_light boolean,
  is_duplicate boolean,
  duplicate_of_upload_id uuid REFERENCES public.uploads(id) ON DELETE SET NULL,
  image_hash text,
  is_screenshot_or_rephoto boolean,
  screenshot_confidence numeric,
  is_tampered_suspected boolean,
  tamper_confidence numeric,
  extracted_vehicle_number text,
  vehicle_number_valid_format boolean,
  image_width integer,
  image_height integer,
  has_exif_metadata boolean,
  overall_confidence numeric,
  raw_analysis_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analysis_results_upload_unique UNIQUE (upload_id)
);

CREATE INDEX idx_uploads_created_at ON public.uploads (created_at DESC);
CREATE INDEX idx_uploads_status ON public.uploads (status);
CREATE INDEX idx_analysis_results_hash ON public.analysis_results (image_hash);

GRANT SELECT ON public.uploads TO anon, authenticated;
GRANT ALL ON public.uploads TO service_role;
GRANT SELECT ON public.analysis_results TO anon, authenticated;
GRANT ALL ON public.analysis_results TO service_role;

ALTER TABLE public.uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Uploads are publicly readable" ON public.uploads FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Analysis results are publicly readable" ON public.analysis_results FOR SELECT TO anon, authenticated USING (true);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER uploads_set_updated_at
BEFORE UPDATE ON public.uploads
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER PUBLICATION supabase_realtime ADD TABLE public.uploads;
ALTER PUBLICATION supabase_realtime ADD TABLE public.analysis_results;