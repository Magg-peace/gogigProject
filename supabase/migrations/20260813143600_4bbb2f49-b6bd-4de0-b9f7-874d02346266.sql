ALTER TABLE public.analysis_results
  ADD COLUMN IF NOT EXISTS ai_generated_confidence numeric,
  ADD COLUMN IF NOT EXISTS ai_verdict text,
  ADD COLUMN IF NOT EXISTS risk_band text;