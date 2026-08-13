
# FieldSight AI — Intelligent Vehicle Media Verification

> Vehicle image inspection you can defend in an audit.

## Architecture at a glance

```text
  Frontend (TanStack Start, React 19)
        |
  Upload API  (server function: object storage + uploads row)  -> returns immediately
        |
  Database (Postgres: uploads / analysis_results / processing_events)
        |
  Queue    (AFTER INSERT trigger -> pg_net -> /api/public/analyze-image)
        |
  Worker   (processUpload — transport agnostic)
        |
  OCR + vision (Gemini Flash: plate, bbox, vehicle detection, entities)
        |
  Forensics (blur, exposure, dHash duplicate, screenshot, ELA tamper, overlay)
        |
  Scoring engine (10 weighted components -> 0-100 trust score + risk band)
        |
  Report generator (deterministic assessment, audit timeline, JSON/CSV/PDF export)
```

## Why async?

Vision OCR takes 3–10 seconds and forensic passes add pixel work on top. Doing that inside
the upload request would hold a connection open for the whole analysis, make the UI feel
broken on mobile networks, and lose the work entirely if the client disconnected. Instead the
upload commits a row and returns; a database trigger dispatches the job out-of-band and the
worker writes results back. The client learns about progress through Realtime (with polling as
a fallback), so the upload path stays fast and the analysis path can be retried independently.

## Graceful degradation

Every inspection report renders the same twelve sections regardless of what succeeded. A failed
OCR stage is recorded as `ocr_status: { status: "failed", error }` and the worker continues with
the pixel-level checks; the report then shows OCR as *failed* with its reason, RTO intelligence
as *unable to decode registration*, and vehicle detection as *unavailable* — nothing is hidden.
Sections are never conditionally removed, so two reports are always directly comparable.

## Risk bands

`90–100 VERIFIED · 70–89 LOW RISK · 50–69 REVIEW REQUIRED · 0–49 HIGH RISK`

## Stack disclosure (read first)

The brief specified Next.js + Express + MongoDB + Redis/BullMQ + Tesseract + OpenCV + Docker.
This project runs on the Lovable managed runtime: **TanStack Start (React 19, Vite, TypeScript)**
on an edge worker, with **Postgres + object storage + realtime** behind it. That runtime has no
Node host, no Redis, and no native binaries, so the specified components were mapped to
equivalents rather than dropped:

| Specified | Implemented here | Why |
| --- | --- | --- |
| Express API | TanStack server functions + `src/routes/api/public/*` HTTP routes | Same request/handler model, one deployable |
| MongoDB | Postgres (`uploads`, `analysis_results`, `processing_events`) | Managed by the platform; JSONB holds the full analyser document |
| Redis + BullMQ | Postgres row-as-message queue: AFTER INSERT trigger -> `pg_net` -> `/api/public/analyze-image` | Keeps upload non-blocking and processing out-of-band. No durable redelivery/DLQ — documented trade-off in `src/lib/pipeline.server.ts` |
| Tesseract.js / OpenCV / Sharp | Hand-rolled pure-JS pixel maths (`src/lib/analysis/*`) + Gemini Flash vision OCR | No WASM worker pool or native addons in the worker sandbox |
| Docker Compose | Platform build/deploy | No container control in this runtime |

`processUpload()` is transport-agnostic: swapping in a real BullMQ worker means replacing
`enqueueAnalysis()` and the trigger only.

## Analysis pipeline

1. Upload -> object storage + `uploads` row (returns immediately)
2. Trigger enqueues the job; worker claims it (`status=processing`)
3. Decode -> EXIF -> dimensions -> blur -> exposure -> contrast -> dHash duplicates -> screenshot -> ELA tamper -> overlay band
4. One multimodal call does plate OCR, plate bbox, plate/vehicle visibility, advertisement coverage and text-entity extraction (`runVisionExtraction`)
5. `assessSyntheticRisk()` runs the Synthetic Image Risk Assessment (nine checks, 0-100 risk score)
6. `decodeRto()` resolves state / RTO office / district / category offline from the plate grammar
7. `runConfidenceEngine()` produces the weighted 0-100 trust score and risk band
8. Deterministic written assessment + audit events; results upserted as `raw_analysis_json` v2

## Confidence engine weights

OCR accuracy 25, plate validation 20, AI authenticity 15, sharpness 15, brightness 10,
plate visibility 10, vehicle visibility 10, metadata integrity 5, duplicate detection 5,
advertisement dominance 5, screenshot detection 5. Raw weights sum to 125 and are normalised to 100; each component
contributes `weight x quality(0..1)`, so the score is a weighted average of positives.

## Trade-offs (deliberate, given the time box)

- Heuristic screenshot / re-photo detection (EXIF gaps, device-screen dimensions, flat UI bands)
  instead of a trained CNN classifier.
- Perceptual hashing (64-bit dHash + Hamming distance) for duplicates instead of vector
  embeddings and an ANN index.
- Offline RTO decoding from the registration grammar instead of live government APIs, which are
  rate-limited, unreliable and require credentials.
- Error Level Analysis as a tamper *suspicion* signal, not proof — it is reported with confidence
  and evidence, never as a verdict.
- A row-as-message queue instead of Redis/BullMQ: no durable redelivery or visibility timeouts,
  but the retry counter and dead-letter policy are implemented on top of it.

## Not implemented

Server-side PDF rendering (the report uses browser print-to-PDF) and Docker packaging.
Everything else in the brief — Google OAuth, async processing, OCR + entity extraction,
vehicle detection,
RTO intelligence, quality score cards, eight forensic checks with evidence and recommendations,
weighted trust scoring, AI assessment, audit timeline, analytics, health probes, dead-letter
queue management, an in-app API reference at `/api-docs`, JSON/CSV export and retry — is live.

---

# VehicleCheck

Asynchronous quality and authenticity screening for field-collected vehicle images.

---

## 1. Overview

Field agents photograph vehicles and upload them; VehicleCheck decides, without a human in the
loop, whether each image is worth keeping. It screens for seven failure modes — blur, low light,
duplicates, screenshots/re-photos, tampering, unreadable plates, and insufficient resolution — and
returns a per-check confidence score rather than a verdict. The consumers are ops reviewers who
need to triage a queue of thousands of images and only look at the ones the pipeline is unsure or
negative about.

## 2. Architecture

Lifecycle of one image:

1. Browser reads the file, validates type/size client-side (fast feedback only), base64-encodes it,
   and calls the `uploadImage` server function.
2. The server re-validates type and size — the client check is UX, this one is the boundary — writes
   the bytes to the private `vehicle-images` Storage bucket under `<uuid>.<ext>`, then inserts an
   `uploads` row with `status='pending'`.
3. The server function returns `{ upload_id, status }` immediately. It never touches pixels.
4. An `AFTER INSERT` trigger on `uploads` calls `pg_net.http_post` against
   `/api/public/analyze-image`. That is the enqueue.
5. The worker route loads the row, flips it to `processing`, downloads the object, runs the seven
   checks, upserts `analysis_results`, and flips the row to `completed`. On any throw it writes
   `failed` + `failure_reason` and increments `retry_count`.
6. The client is subscribed to Postgres changes on that `uploads` row via Realtime, so the status
   badge and the detail page update without polling.

```
                 +--------------------------------------------+
                 |                  Browser                    |
                 |  Upload page   Dashboard   Detail page      |
                 +----+-------------------------------^-------+
   uploadImage()      |                                | Realtime (postgres_changes on uploads)
   RPC (base64)       v                                |
              +-------+--------+                       |
              |  Upload API    |                       |
              | uploads.server |                       |
              +---+--------+---+                       |
     putObject()  |        | INSERT uploads            |
                  v        v (status='pending')        |
        +---------+--+  +--+-----------------+         |
        |  Storage   |  |   Postgres         +---------+
        | vehicle-   |  |  uploads           |
        | images     |  |  analysis_results  |
        +-----^------+  +--+-----------------+
              |            | AFTER INSERT trigger
              |            v
              |    +-------+---------------------+
              |    | pg_net.http_post            |
              |    +-------+---------------------+
              |            v
              |    +-------+---------------------+
              +----+ Analysis worker             |
        download   | /api/public/analyze-image   |
                   | -> processUpload()          |
                   +-------+---------------------+
                           | UPSERT analysis_results
                           | UPDATE uploads.status
                           v
                       Postgres  ->  Results API (getUploadResultsFn) -> Browser
```

Deviation from the brief worth naming: the app runs on TanStack Start, which already has a server
runtime deployed next to the app. `upload-image` and `analyze-image` are therefore a **server
function** and a **server route** instead of two Supabase Edge Functions. The boundaries, the
trigger, and the async semantics are identical; the difference is that the worker shares a type
system and a repo with the frontend, and there is no separate deploy artifact.

### Tables

**`uploads`** — one row per submitted file. This table *is* the queue message.

| Column | Why it exists |
| --- | --- |
| `id` | Returned to the client synchronously; also the Storage object name, so the two stores are correlatable without a join table. |
| `file_path` | Storage key. Kept separate from `id` because extension and future prefixing (date partitioning) must be able to change without breaking references. |
| `original_filename` | Only for display; never trusted as a path component. |
| `file_size_bytes`, `mime_type` | Recorded post-validation so a rejected-but-stored file can be diagnosed later, and so the worker knows which decoder to pick without sniffing. |
| `status` | The state machine. CHECK-constrained to four values so no code path can invent a fifth. |
| `failure_reason` | Human-readable, surfaced directly in the UI. A reviewer should never have to open logs to know why something failed. |
| `retry_count` | Delivery counter. With no broker there is no automatic redelivery, so this is the only record of how many attempts an image has cost — and the input to any future "stop retrying" policy. |
| `created_at` / `updated_at` | `updated_at` is trigger-maintained; the gap between them is the de-facto processing latency metric. |

**`analysis_results`** — one row per upload (`UNIQUE(upload_id)`, so reprocessing upserts instead of
accumulating duplicates).

| Column | Why it exists |
| --- | --- |
| `is_blurry`, `is_low_light`, `is_duplicate`, `is_screenshot_or_rephoto`, `is_tampered_suspected` | Cheap indexed filters for "show me everything flagged". |
| `blur_score`, `brightness_score`, `screenshot_confidence`, `tamper_confidence`, `overall_confidence` | `numeric`, not boolean, because **every threshold in this system is a guess**. Storing the score means a threshold change is a re-query, not a re-processing run of the whole corpus. It also lets the UI say "65% confidence" instead of "yes". |
| `image_hash` | 64-bit dHash as hex. Indexed; the duplicate check scans it. |
| `duplicate_of_upload_id` | FK to the earlier upload, so the UI can link to the original. `ON DELETE SET NULL` — losing the original must not delete the newer analysis. |
| `extracted_vehicle_number`, `vehicle_number_valid_format` | Stored separately: OCR can produce a string that fails the format check, and that combination is itself a signal (bad photo vs. bad plate). |
| `image_width`, `image_height`, `has_exif_metadata` | Raw inputs to the screenshot and resolution heuristics; kept so a scoring change can be replayed without redecoding. |
| `raw_analysis_json` | Everything the scalar columns flatten away: per-check intermediates, ELA block statistics, the screenshot signal list, and `processing_logs[]` with a per-step status and duration. This is the debugging surface. |

## 3. Processing Flow & Queue Strategy

### What "async" means here

There is no broker. `pg_net` fires an HTTP POST from inside the transaction commit path of the
`uploads` INSERT; the worker route returns its own response independently of the upload request,
which has already been answered. That buys the two properties that actually matter at the API
boundary: the client never waits on analysis, and analysis runs in a different execution context
from the request that created the work.

What it does not buy: durable redelivery, visibility timeouts, backpressure, ordering, concurrency
control, or a dead-letter queue. If the worker invocation is lost — cold start timeout, deploy
mid-flight, `pg_net` request dropped — the row sits at `pending` or `processing` forever and nothing
notices. That is the honest cost.

### Why this and not SQS/BullMQ for a 48-hour build

A real broker means a Redis or SQS instance, a long-running worker process to poll it, a deploy
target for that process, and a health/restart story — none of which the serverless target here
provides, and all of which are infrastructure work rather than pipeline work. The interesting part
of this assignment is the analysis and the failure semantics; the trigger gets us to the same
observable behaviour for a few lines of SQL.

Swapping in a real queue touches exactly two things:

- **Replace** `enqueueAnalysis(uploadId, origin)` in `src/lib/pipeline.server.ts` — currently a
  `fetch` — with `queue.add('analyze', { uploadId })`, and drop the `public.enqueue_analysis()`
  trigger.
- **Replace** the transport shell `src/routes/api/public/analyze-image.ts` with a worker process
  that calls the same function.
- **Unchanged**: `processUpload(supabase, uploadId)` and every function in
  `src/lib/analysis/*`. `processUpload` takes a client and an id, reads its own state from
  Postgres, and is transport-agnostic on purpose. That separation is the whole point of splitting
  "enqueue" from "process".

A real queue would also let `retry_count` drive automatic exponential backoff instead of being a
display value that only a human acts on.

### State machine

```
      insert                trigger/worker            all checks written
none ---------> pending -----------------> processing -------------------> completed
                   ^                            |
                   |  retryUpload()             | throw (any step)
                   +------------ failed <-------+
```

- `pending` — the row exists, no worker has claimed it. Set by the INSERT default.
- `processing` — the worker has loaded the row and is working. Set as the first write in
  `processUpload`, before the download, so a crashed run is distinguishable from an unclaimed one.
- `completed` — `analysis_results` was written successfully. Never set before the results upsert.
- `failed` — anything in the try block threw. Sets `failure_reason` and increments `retry_count` in
  the same statement.

### Retries

A retry is only ever triggered by a human clicking Retry on a `failed` upload. `retryUploadFn`
refuses if the row is `processing`, resets `status` to `pending`, clears `failure_reason`, and
re-enqueues.

What is idempotent: the analysis itself. Every check is a pure function of the stored bytes, and the
results write is an upsert on `UNIQUE(upload_id)`, so N runs produce one row. Storage is untouched
by the worker. Re-running is safe.

What is not guarded:

- **Double-processing.** The `processing` guard is a read-then-write, not a conditional update. Two
  invocations arriving within the same few milliseconds (trigger + the fallback dispatch in
  `createUpload`, or an impatient double-click) can both pass the check. The consequence is wasted
  OCR spend and duplicated logs, not corruption, because of the upsert. The fix is a single
  `UPDATE ... WHERE status IN ('pending','failed') RETURNING id` claim — cheap, and worth doing
  before this goes near production volume.
- **Stuck `processing` rows.** If the worker dies mid-run, nothing resets the row. There is no
  visibility timeout and no reaper. A `pg_cron` job flipping `processing` rows older than five
  minutes back to `failed` would close this in ~10 lines.
- **Partial writes.** The results upsert and the status flip are two statements, not one
  transaction. A crash between them leaves a complete `analysis_results` row with the upload stuck
  at `processing`. A retry corrects it, since the upsert overwrites.
- **`retry_count` counts failures, not attempts.** A run that hangs forever never increments it.

## 4. Image Analysis Design

Constraint that shaped all seven: the worker runs in a serverless Worker sandbox. No native
addons — no OpenCV, no sharp, no Tesseract binary, no canvas. Decoding is `jpeg-js` + `fast-png`
into a plain RGBA byte buffer, and every kernel below is hand-written over that buffer. That rules
out the accurate-but-heavy options before any accuracy argument is even made.

Each check lives in `src/lib/analysis/checks.server.ts` as a standalone exported function taking a
decoded image, so it can be tested against a fixture without a database, Storage, or a queue.

### 1. Blur — `detectBlur`

Grayscale (BT.601 luma) → nearest-neighbour resample to a 512px longest edge → 4-neighbour Laplacian
→ variance of the response. Sharp edges produce large positive and negative kernel responses, so
high variance means detail; a blurred image's responses cluster near zero. Threshold 120.

**Why not a real CV pipeline.** Laplacian variance is one pass over the pixels and needs no model.
Anything better — a no-reference sharpness CNN, frequency-domain analysis — costs a model download
per cold start for a check that only needs to be right at the extremes.

**The resample is load-bearing.** Laplacian variance scales with pixel density: the same scene at
12MP scores several times higher than at 0.5MP. Comparing raw variance against a fixed threshold
across mixed-resolution uploads produces systematic false negatives on high-res images. Normalising
to a fixed working size makes the threshold mean the same thing for every input.

**Known failure modes.** A genuinely sharp photo of a low-texture subject — a plain white van panel
filling the frame, an overcast sky background — has little edge energy and reads as blurry. The
inverse also holds: heavy sensor noise in a dark, blurry night photo inflates variance and can pass
it as sharp. Motion blur in one axis only (a passing vehicle) still leaves vertical edges intact and
scores mid-range.

**Why a score.** 120 was picked by eyeballing sample images, not derived. The score is stored so the
threshold can move later; the UI shows the raw Laplacian variance next to "Likely blurry — 78%
confidence" so a reviewer can calibrate their own trust.

### 2. Brightness / low light — `detectLowLight`

Mean luma over all pixels (0–255) plus the fraction of pixels below 40. Below a mean of 62 is
flagged; the confidence blends the mean shortfall with the dark-pixel ratio, so an image that is
merely dim scores lower than one that is dim *and* mostly crushed to black.

**Why not a histogram/percentile model.** Mean plus one dark-ratio term catches the actual failure
case (photo taken at dusk with no flash) at a single pass and no tuning surface.

**Failure modes.** A correctly exposed photo of a black vehicle at night against a black background
is indistinguishable from an underexposed one by mean luma. Conversely a night photo with a
streetlight or flash blowout has an acceptable mean while the vehicle itself is unreadable — this
check has no spatial awareness at all, so a locally dark subject in a bright frame passes.

**Why a score.** Exposure is a continuum with no natural cutoff; a reviewer looking at "mean luma
81/255, 0% near-black" can judge faster than from a boolean.

### 3. Duplicate — `computeDifferenceHash` / `findDuplicate`

64-bit difference hash: resample to 9×8 grayscale, emit one bit per horizontal
neighbour comparison. Compared against every prior stored hash by Hamming distance; ≤8 of 64 bits
is a duplicate, and the matched `upload_id` is stored.

**Why dHash over aHash or pHash.** Average-hash keys on absolute brightness and breaks under
exposure differences between two photos of the same vehicle. Perceptual-hash (DCT-based) is more
robust but needs a DCT implementation for a marginal gain at this corpus size. dHash encodes
gradient direction, which survives resize, re-compression, and moderate brightness shifts — the
transformations a re-submitted image actually undergoes.

**Failure modes.** The comparison is a linear scan capped at 2000 prior hashes; beyond that it
silently stops being exhaustive, and beyond ~100k rows the scan itself is the bottleneck (a BK-tree
or a `bit_count(hash # hash)` index is the fix). dHash is not rotation- or crop-invariant: the same
photo cropped 10% is a different hash. And it is *too* tolerant in the other direction — two
different white sedans photographed from the same angle in the same parking bay can land inside 8
bits, which is a false positive with real consequences for an agent accused of resubmitting work.

**Why a score.** The confidence is derived from the actual Hamming distance, so a distance-2 match
(near-certain re-upload) and a distance-8 match (suspicious) are visibly different in the UI, and
the exact distance is shown.

### 4. Screenshot / photo-of-photo — `detectScreenshot`

Weighted signal sum, capped at 1.0: no EXIF block (+0.40), no camera make/model (+0.10), dimensions
matching a known device screen resolution (+0.30), both dimensions exact powers of two (+0.10), PNG
container (+0.15), and a uniform flat band along any edge (+0.15) — detected by scanning the outer
2% of rows/columns for near-constant luma, which is what a status bar, an app toolbar, or
letterboxing looks like. Flagged above 0.55.

**Why heuristic stacking, not a classifier.** A screenshot detector trained on device UI would be
better and needs a labelled dataset that does not exist here. These signals are free — three of them
come from data already extracted for other checks.

**Failure modes.** The dominant signal is EXIF absence, and EXIF is stripped by every messaging app
in India: a genuine camera photo forwarded over WhatsApp lands at 0.50–0.65 and gets flagged. That
is the single largest false-positive source in the system. Conversely a screenshot re-saved as JPEG
at an unusual crop size scores under 0.4 and passes. The UI chrome detector fires on any photo with
a genuinely uniform edge — a vehicle shot against a plain wall.

**Why a score.** Precisely because of the WhatsApp problem. A boolean would be wrong often enough to
be ignored; a 65% with the contributing signals listed ("no EXIF block present", "PNG container")
lets a reviewer dismiss it in one glance. The UI renders that signal list verbatim.

### 5. Tamper suspicion — `detectTampering`

Two independent signals. **Error Level Analysis:** downscale to 640px, re-encode at JPEG quality 80,
diff against the original, and compute per-16px-block mean absolute error. Regions previously saved
at a different quality — pasted content — recompress differently from their surroundings, so the
metric is the fraction of blocks more than 3 standard deviations above the mean error, not the error
itself. **Metadata:** the EXIF `Software` tag matched against a list of known editors (Photoshop,
GIMP, Snapseed, Picsart, …), plus EXIF present but `DateTimeOriginal` stripped, which is the
signature of a re-save.

**Why ELA and not forensic tooling.** Proper tamper detection is CFA/PRNU/noise-residual analysis
and is a research problem. ELA is the cheapest signal that responds to the specific thing being
guarded against — a plate number or damage area pasted into an otherwise real photo.

**Failure modes.** ELA is close to worthless on images that have already been recompressed several
times (every forward through a chat app), because the whole frame converges to a uniform error
floor and the outlier ratio collapses to zero. It also fires on legitimate high-contrast regions —
text, chrome trim, specular highlights recompress badly everywhere. The metadata half is trivially
defeated by stripping EXIF, which also *reduces* this score while *raising* the screenshot score.
Treat a low tamper score as no information at all, not as evidence of authenticity.

**Why a score.** This check is the weakest of the seven and must never read as an accusation. The UI
shows the confidence plus the literal signals that produced it ("2.3% of 16px blocks show abnormal
recompression error"), so the reviewer judges the evidence rather than the label.

### 6. OCR + Indian plate format — `runPlateOcr` / `validateIndianPlate`

The image is sent to a multimodal model through the AI gateway with a JSON-only prompt asking for
the plate string and the model's own confidence. The returned text is normalised (uppercased,
`IND` prefix dropped, non-alphanumerics removed) and tested against
`^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$` — state code, RTO district, series, four-digit number.

**Why a vision model, not Tesseract.** No Tesseract binary runs in this sandbox, and the WASM build
plus training data is a large cold-start cost. More to the point, Tesseract on an unrectified,
angled, dirty plate in a general-purpose photo performs poorly without a plate-localisation stage in
front of it — which would be the actual work. The vision model does localisation and recognition in
one call.

**Failure modes.** It is a network call, so it is the slowest step (~1.5s) and the only one that can
time out; it is wrapped separately from the main try/catch and degrades to `extracted_vehicle_number
= null` instead of failing the upload. Models hallucinate plausible plates from illegible pixels,
and a hallucination frequently *passes* the format regex — format validity is therefore not evidence
of correctness. The regex itself rejects valid real-world plates: BH-series (`22 BH 1234 AA`),
diplomatic/military formats, and vanity spacing. Both the raw string and the validity flag are
stored so a later regex fix does not require re-running OCR.

**Why a score.** The model's self-reported confidence is stored and shown next to an explicit note
that the value is a suggestion, not a verified registration. This is the one check where a confident
wrong answer is more damaging than no answer.

### 7. Dimensions — `validateDimensions`

Both sides must be ≥480px. The only deterministic check in the set; its "confidence" is just how far
below the floor the smaller side is.

**Why a floor and not a rejection.** Rejecting at upload time would lose the file. The image is
stored and flagged instead, because a 400×300 photo of a clearly readable plate is still useful
evidence and a human should make that call.

**Failure modes.** Resolution is not quality — a 4000×3000 upscale of a 200px thumbnail passes this
check and every dimension-based signal, while carrying no more detail. Pairing it with blur catches
most of those.

### 8. Synthetic Image Risk Assessment — `assessSyntheticRisk`

Detects whether an upload may be AI-generated, digitally synthesised, heavily edited, or simply not
an original field photograph. Nine weighted checks: metadata authenticity (EXIF presence, camera
make/model, timestamp, generator software tags), screenshot indicators (PNG container, known device
screen resolutions, missing camera metadata), OCR naturalness (implausibly perfect reads and
unnaturally clean plate edges), texture consistency (over-smoothing, missing sensor noise, repeated
texture signatures), reflection consistency, shadow consistency, plate realism, compression
signature (high-pass residual distribution) and object geometry (warped parts, distorted wheels,
broken symmetry). Six are measured on the pixel buffer; four semantic ones come from the Gemini 2.5
Flash vision pass, which returns graded 0..1 likelihoods rather than verdicts.

Output: a Synthetic Risk Score (0-100), the complementary Authenticity Score, an assessment
confidence describing how much evidence was available, per-check evidence strings, and one of three
verdicts — 0-30 **Likely Authentic**, 31-70 **Suspicious**, 71-100 **Likely Synthetic**.

Trust-score integration: AI authenticity carries 15% of the weighted score, and a high synthetic
risk is additionally applied as a hard deduction (>70 deducts 25 points, >85 deducts 40) because a
fully synthetic frame can otherwise score perfectly on sharpness, exposure and OCR. Above 95 the
inspection is forced to HIGH RISK regardless of the numeric score.

**Guard rail.** Missing metadata alone never escalates past "Suspicious" — a pixel-level or semantic
signal must corroborate it, otherwise every WhatsApp-forwarded field photo would be flagged.

> AI-generated image detection is heuristic-based and intended as a risk indicator, not a definitive
> forensic determination.

### Composite score

`computeOverallConfidence` does not average. The worst penalty gets 70% of the weight and the mean
of the rest gets 30%, so an image that is severely blurry but clean on six other checks still scores
poorly. Averaging would have let five passing checks dilute one disqualifying flag — which is
exactly backwards for a screening tool.

## 5. AI Usage Disclosure

**Written by AI, unmodified:** the shadcn/Tailwind component scaffolding, the SQL DDL for both
tables plus RLS policies and grants, the CRUD/status/list/retry server functions, the pg_net trigger
function, and the React page structure (upload dropzone, dashboard grid, detail layout). These are
patterns with a single obvious correct shape; AI produces them faster than hand-writing and the
failure mode is a compile error, not a silent wrong answer.

**Written by AI, then corrected:** all seven analysis functions, the composite score, and the
retry/idempotency semantics. Concretely:

1. **Blur threshold with no resolution normalisation.** The first version computed Laplacian
   variance on the full-resolution grayscale buffer and compared it against a fixed 100. Because
   variance scales with pixel density, a 12MP phone photo scored 4–6× higher than a 640px image of
   the same scene, so the threshold was effectively unreachable for large images (false negatives)
   and trigger-happy for small ones. Fixed by resampling to a fixed 512px working size before the
   kernel — the threshold now means one thing regardless of input size.
2. **Overall confidence as an arithmetic mean.** The generated version averaged all seven
   confidences. An image that was unusably blurry (0.9) but clean elsewhere averaged to ~0.13
   penalty and presented as acceptable — the opposite of what a screening tool should do. Replaced
   with worst-signal-dominant weighting (0.7 worst / 0.3 mean-of-rest).
3. **OCR failure treated as pipeline failure.** The generated worker had the OCR call inside the
   main try block, so a provider timeout marked the whole upload `failed` and discarded six
   perfectly good check results. Pulled into its own try/catch that logs a degraded step and
   continues; a missing plate is a result, not an error.
4. **Duplicate detection compared against `uploads`, not `analysis_results`,** and had no
   `neq(upload_id)` filter — every image matched itself with distance 0 and was flagged as a
   duplicate of itself on the first run.
5. **Average-hash instead of difference-hash.** The first implementation thresholded each pixel
   against the image mean, which flips en masse under exposure changes; two photos of the same
   vehicle taken seconds apart at different exposures scored a Hamming distance in the 20s.

**How each piece was validated.** The seven analysis functions were read line by line against the
algorithm they claim to implement — the Laplacian kernel signs, the dHash bit ordering, and the ELA
block statistics were each checked by hand before being trusted. The pipeline was then run
end-to-end against a synthetic vehicle image with a known plate (`MH12AB1234`): OCR returned the
exact string, the format regex passed, the plate-free checks produced plausible values (Laplacian
variance 565, mean luma 81, dHash `acacacac80808400`), and the per-step timings in
`processing_logs` confirmed every step actually executed rather than short-circuiting. EXIF parsing
was verified against both a JPEG with camera metadata and a PNG with none. Realtime status
transitions were observed in a real browser session, not assumed from the code.

**The honest limitation.** The thresholds in this system (120 Laplacian variance, 62 mean luma, 8
bits Hamming, 0.55 screenshot, 0.5 tamper) are defensible starting points, not empirically derived
values. There is no labelled corpus of known-good and known-bad field photos here, so nobody —
human or AI — has measured the false-positive rate of any check. Everything above about failure
modes is reasoning about the algorithms, not observed error rates. Before this screened real agent
submissions I would want a few hundred hand-labelled images per check and a threshold sweep, and I
would expect at least two of the current thresholds to move materially. Treating the current numbers
as tuned would be the most likely way for this system to quietly do harm.

## 6. Trade-offs & What Was Intentionally Simplified

**Cut deliberately:**

- **Authentication and multi-tenancy.** Every upload is world-readable. Adding auth would mean
  agent accounts, org scoping, and RLS on `agent_id` — real work that demonstrates nothing about the
  pipeline, which is what is being evaluated. The RLS policies are already in place and read-only
  for anon; scoping them to an owner column is a one-migration change.
- **Automatic retry with backoff.** Retry is manual only. Automatic retry without a claim lock would
  amplify the double-processing race rather than fix it, so the lock has to come first.
- **A test suite.** The seven checks are written as pure functions specifically so they are
  testable, and the fixtures (a sharp image, a blurred copy, a screenshot, a duplicate) are the real
  cost — writing the assertions is trivial once labelled fixtures exist. Shipping untested-but-
  isolated functions was the better trade than shipping tests against arbitrary thresholds.
- **Thumbnail generation.** The dashboard serves full-size originals through signed URLs and scales
  them in CSS. Fine at demo scale, wasteful immediately after.

**With a week instead of 48 hours:** labelled fixture corpus and a threshold sweep for every check;
a `SELECT ... FOR UPDATE`-style atomic claim plus a `pg_cron` reaper for stuck `processing` rows;
derived thumbnails written at upload time; per-check version stamps in `analysis_results` so results
from different scoring versions are comparable; and a plate-localisation crop before OCR (detect the
plate region, send only that crop) which would cut token cost and improve accuracy simultaneously.

**What breaks first under load.** OCR. It is a synchronous network call inside the worker, ~1.5s and
a metered API, so it dominates both latency and cost — at a few hundred uploads/minute this hits
provider rate limits long before anything else strains. Second is duplicate detection: the linear
scan over `analysis_results.image_hash` is capped at 2000 rows today and degrades from
"approximate" to "wrong" past that, then becomes the query bottleneck around ~100k rows. Third is
worker concurrency — `pg_net` fires one request per insert with no concurrency ceiling, so a bulk
import of 10k images issues 10k simultaneous invocations, which is precisely the backpressure a real
queue would provide and this design does not. Storage bandwidth (full-size downloads in the worker,
full-size originals on the dashboard) matters after that.

**Failure handling, specifically:**

- *Worker crashes mid-processing* — row is stranded at `processing` forever. No reaper, no
  visibility timeout. Only a human noticing on the dashboard recovers it, and Retry refuses while
  the status is `processing`, so it currently requires a manual status reset.
- *Storage upload succeeds, DB insert fails* — `createUpload` issues a compensating
  `storage.remove()`. That delete is itself unguarded: if it fails, the object is orphaned and
  nothing reaps it. There is no cross-store transaction.
- *DB insert succeeds, trigger's HTTP post fails* — row sits at `pending` indefinitely. Partly
  mitigated by the direct dispatch in `createUpload`, but that too is fire-and-forget; if both miss,
  the upload is silently never analysed.
- *OCR times out or errors* — handled. Logged as a degraded step in `processing_logs`, upload still
  completes with a null plate. The `fetch` has no explicit timeout, though, so a hanging provider
  connection can stall the worker to its runtime limit.
- *Image decode fails on a corrupt or mislabelled file* — caught, upload marked `failed` with the
  decoder's message. A PNG with a `.jpg` extension and a `image/jpeg` MIME lands here; the fix is
  magic-byte sniffing rather than trusting the declared type.
- *Duplicate-hash query fails* — currently fatal for the whole upload, which is over-strict. It
  should degrade like OCR does.

## 7. Running Instructions

The app is a TanStack Start project against a managed Postgres + Storage backend.

```bash
npm install
npm run dev        # http://localhost:8080
```

Environment (injected automatically in Lovable; needed for a local/self-hosted run):

| Variable | Scope | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | client | Realtime subscriptions |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | client | Realtime subscriptions |
| `SUPABASE_URL` | server | Storage + Postgres from the worker |
| `SUPABASE_SERVICE_ROLE_KEY` | server | Worker writes, signed URLs |
| `LOVABLE_API_KEY` | server | Vision-model OCR |

Schema and Storage bucket are created by the migrations already applied to the project
(`uploads`, `analysis_results`, the `updated_at` trigger, the `vehicle-images` private bucket, and
the `enqueue_analysis` trigger).

**Running three images end-to-end.** No seed script is needed — the pipeline only has one entry
point:

1. Open `/`, drop `sharp-vehicle.jpg` (a normal camera photo with EXIF intact). Expect
   `completed`, low blur/screenshot confidence, and a plate read if one is visible.
2. Drop the *same file again*. Expect `is_duplicate = true`, Hamming distance 0, and a link back to
   the first upload on the detail page.
3. Drop `screenshot.png` (a phone screenshot of a listing). Expect a screenshot confidence above
   0.6 with "no EXIF block present" and "PNG container" in the signal list.

Watch `/dashboard` while these run: badges move `pending → processing → completed` over Realtime
with no refresh. To exercise the failure path, delete an object from the Storage bucket and hit
Retry on its upload — the worker fails on download, writes a readable `failure_reason`, and
increments `retry_count`.

Worker logs are prefixed `[analyze:<upload_id>]` and `[upload]`, one line per step.

## 8. Sample API Requests/Responses

The API is exposed as typed server functions (RPC over POST) plus one HTTP route for the worker.
Payload shapes below are the real ones.

**Upload** — `uploadImage({ data })`

```json
{ "filename": "car.jpg", "mimeType": "image/jpeg", "base64": "/9j/4AAQSkZJRgABAQ..." }
```

```json
{ "upload_id": "aefe90ba-456d-4922-9dec-cc95e1af4888", "status": "pending", "file_path": "aefe90ba-456d-4922-9dec-cc95e1af4888.jpg" }
```

Validation failures return an error with a user-facing message, e.g.
`Unsupported file type "image/webp". Only JPEG and PNG images are accepted.` or
`File is 14.2 MB — the limit is 10 MB.`

**Status** — `getUploadStatusFn({ data: { id } })`, the four states:

```json
{ "id": "aefe90ba-...", "status": "pending",    "failure_reason": null, "retry_count": 0, "created_at": "2026-08-12T17:34:51.402Z", "updated_at": "2026-08-12T17:34:51.402Z" }
{ "id": "aefe90ba-...", "status": "processing", "failure_reason": null, "retry_count": 0, "created_at": "2026-08-12T17:34:51.402Z", "updated_at": "2026-08-12T17:34:52.118Z" }
{ "id": "aefe90ba-...", "status": "completed",  "failure_reason": null, "retry_count": 0, "created_at": "2026-08-12T17:34:51.402Z", "updated_at": "2026-08-12T17:34:55.733Z" }
{ "id": "b1c4e0d2-...", "status": "failed",     "failure_reason": "Storage download failed: Object not found", "retry_count": 2, "created_at": "2026-08-12T17:40:02.900Z", "updated_at": "2026-08-12T17:41:10.554Z" }
```

**Results** — `getUploadResultsFn({ data: { id } })` (abridged `raw_analysis_json`):

```json
{
  "upload": {
    "id": "aefe90ba-456d-4922-9dec-cc95e1af4888",
    "file_path": "aefe90ba-456d-4922-9dec-cc95e1af4888.jpg",
    "original_filename": "car.jpg",
    "file_size_bytes": 85402,
    "mime_type": "image/jpeg",
    "status": "completed",
    "failure_reason": null,
    "retry_count": 0
  },
  "image_url": "https://<storage-host>/object/sign/vehicle-images/aefe90ba-....jpg?token=...",
  "result": {
    "upload_id": "aefe90ba-456d-4922-9dec-cc95e1af4888",
    "is_blurry": false,
    "blur_score": 564.61,
    "brightness_score": 81.27,
    "is_low_light": false,
    "is_duplicate": false,
    "duplicate_of_upload_id": null,
    "image_hash": "acacacac80808400",
    "is_screenshot_or_rephoto": true,
    "screenshot_confidence": 0.65,
    "is_tampered_suspected": false,
    "tamper_confidence": 0,
    "extracted_vehicle_number": "MH12AB1234",
    "vehicle_number_valid_format": true,
    "image_width": 1024,
    "image_height": 768,
    "has_exif_metadata": false,
    "overall_confidence": 0.545,
    "raw_analysis_json": {
      "version": 1,
      "total_ms": 3612,
      "exif": { "hasExif": false, "make": null, "model": null, "software": null, "dateTimeOriginal": null },
      "blur": { "blur_score": 564.61, "is_blurry": false, "blur_confidence": 0 },
      "brightness": { "brightness_score": 81.27, "dark_pixel_ratio": 0.0031, "is_low_light": false, "low_light_confidence": 0 },
      "duplicate": { "is_duplicate": false, "duplicate_of_upload_id": null, "nearest_distance": null, "duplicate_confidence": 0, "image_hash": "acacacac80808400" },
      "screenshot": { "is_screenshot_or_rephoto": true, "screenshot_confidence": 0.65, "screenshot_signals": ["no EXIF block present (camera photos almost always carry one)", "no camera make/model tags", "uniform flat band along bottom — possible UI chrome or letterboxing"] },
      "tamper": { "is_tampered_suspected": false, "tamper_confidence": 0, "tamper_signals": [], "ela": { "mean_block_error": 1.284, "stddev_block_error": 2.011, "outlier_block_ratio": 0, "blocks_measured": 1200 } },
      "ocr": { "raw_text": "MH12AB1234", "model_confidence": 1, "note": "OCR output is probabilistic; treat the plate string as a suggestion, not a verified registration.", "normalised": "MH12AB1234" },
      "dimensions": { "image_width": 1024, "image_height": 768, "insufficient_resolution": false, "resolution_confidence": 0 },
      "processing_logs": [
        { "step": "download_from_storage", "status": "ok", "ms": 1286 },
        { "step": "decode_image", "status": "ok", "ms": 182 },
        { "step": "check_blur", "status": "ok", "ms": 34 },
        { "step": "ocr_plate", "status": "ok", "ms": 1638, "detail": "MH12AB1234" }
      ]
    }
  }
}
```

If `status !== 'completed'`, `result` is `null` and only `upload` + `image_url` are returned.

**List** — `listUploadsFn({ data: { page: 1, pageSize: 12 } })` →
`{ "uploads": [...], "total": 37, "page": 1, "page_size": 12, "thumbnails": { "<file_path>": "<signed url>" } }`

**Retry** — `retryUploadFn({ data: { id } })` → `{ "upload_id": "b1c4e0d2-...", "status": "pending" }`;
rejects with `This upload is already being processed.` if the row is `processing`.

**Worker (HTTP)** — `POST /api/public/analyze-image`, accepts both the direct shape and a Database
Webhook payload:

```json
{ "upload_id": "aefe90ba-456d-4922-9dec-cc95e1af4888" }
{ "type": "INSERT", "table": "uploads", "record": { "id": "aefe90ba-..." } }
```

```json
{ "ok": true, "upload_id": "aefe90ba-...", "overall_confidence": 0.545 }
{ "ok": false, "upload_id": "b1c4e0d2-...", "failure_reason": "Storage download failed: Object not found", "logs": [...] }
```

## 9. Assumptions Made

- **"Duplicate" means visually near-identical, not the same vehicle.** Two different photos of the
  same car from different angles are not duplicates here. The target is resubmission of the same
  capture, possibly resized or recompressed. Hamming ≤8/64 encodes that judgement.
- **Duplicate scope is global and unbounded in time.** No per-agent or per-day partitioning, and no
  expiry — an image matching one from six months ago is still flagged.
- **JPEG and PNG only.** No HEIC (the default on iPhones, which in practice means a real deployment
  needs a conversion step), no WebP, no multi-frame formats.
- **Plates are Indian civilian format.** BH-series, diplomatic, and military registrations will fail
  format validation even when OCR reads them correctly.
- **One plate per image.** The OCR prompt asks for a single plate; a photo containing two vehicles
  returns whichever the model prefers.
- **False positives are cheaper than false negatives.** Every threshold leans toward flagging. A
  flagged good image costs one reviewer glance; an accepted bad image corrupts downstream data.
  The screenshot check is deliberately the most trigger-happy for this reason, and is also the one
  most likely to need loosening once real rates are measured.
- **No acceptable-rate target has been set for any check** because none has been measured — see the
  limitation in section 5.
- **The uploader is trusted enough not to need auth.** No rate limiting, no per-agent attribution,
  no abuse controls. Reasonable for an internal screening tool behind an existing app boundary;
  not for a public endpoint.
- **Images are retained indefinitely.** No lifecycle policy, no deletion path, no PII handling for
  faces or bystanders that appear in field photos.
