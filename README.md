# FieldSight AI

### Intelligent Vehicle Media Verification & Fraud Detection System

FieldSight AI is an asynchronous image inspection platform that analyzes uploaded vehicle images and detects quality, authenticity, and compliance issues before they enter operational workflows.



---

## Live Demo

https://gogigmeghana.lovable.app

---

## Problem Statement

Field agents frequently upload vehicle images that may suffer from:

- Blur
- Poor lighting
- Duplicate submissions
- Screenshots or photo-of-photo captures
- Tampered or edited images
- AI-generated images
- Invalid vehicle registration formats

FieldSight AI automatically evaluates uploaded images and generates a structured inspection report with confidence scoring and auditability.

---

# Architecture


<img width="1628" height="667" alt="image" src="https://github.com/user-attachments/assets/df72ad2d-920f-46bb-bc24-787b9d0d4a0a" />




---

# Features

## Core Features

- Asynchronous image processing
- OCR-based vehicle number extraction
- Indian number plate validation
- RTO intelligence decoding
- Duplicate image detection
- Blur detection
- Brightness analysis
- Screenshot detection
- Tampering detection (ELA)
- AI-generated image detection
- Confidence scoring engine
- Risk categorization
- Detailed audit timeline
- JSON / CSV / PDF export

---

# Analysis Modules

## Image Quality

- Blur Detection
- Brightness Analysis
- Contrast Analysis
- Resolution Validation

## Vehicle Intelligence

- Number Plate OCR
- Plate Validation
- State Detection
- RTO Office Mapping

## Forensic Analysis

- Duplicate Detection
- Screenshot Detection
- Photo-of-Photo Detection
- Tampering Detection
- Metadata Validation
- Advertisement Dominance Analysis

## AI Authenticity Analysis

- Synthetic Image Risk Assessment
- Metadata Authenticity Checks
- Texture Consistency Analysis
- Reflection Consistency Analysis
- Shadow Consistency Analysis
- Compression Artifact Analysis

---

# Trust Score Engine

FieldSight AI calculates a weighted confidence score using multiple inspection components.

| Component | Weight |
|------------|---------|
| OCR Accuracy | 25% |
| Plate Validation | 20% |
| AI Authenticity | 15% |
| Sharpness | 15% |
| Brightness | 10% |
| Plate Visibility | 10% |
| Vehicle Visibility | 10% |
| Metadata Integrity | 5% |
| Duplicate Detection | 5% |
| Advertisement Dominance | 5% |
| Screenshot Detection | 5% |

## Risk Bands

| Score | Category |
|---------|---------|
| 90–100 | VERIFIED |
| 70–89 | LOW RISK |
| 50–69 | REVIEW REQUIRED |
| 0–49 | HIGH RISK |

---

# User Interface

## Landing Page

- Product Overview
- Feature Highlights
- System Architecture Overview
- How It Works Section
- Call-to-Action Upload Button

## Dashboard

- Inspection Statistics
- Recent Upload Activity
- Risk Distribution
- Processing Status Monitoring
- Analytics Overview

## Inspection Report

- Original Image Preview
- Bounding Box Visualization
- Cropped Number Plate View
- OCR Extraction Results
- RTO Intelligence
- Quality Analysis
- Forensic Analysis
- AI Authenticity Assessment
- Trust Score Breakdown
- Audit Timeline

---

# Technology Stack

## Frontend

- React 19
- TypeScript
- TanStack Start
- Tailwind CSS
- ShadCN UI

## Backend

- TanStack Server Functions
- PostgreSQL
- Supabase Storage
- Supabase Realtime

## AI & Analysis

- Gemini Vision API
- OCR Extraction
- dHash Duplicate Detection
- Error Level Analysis (ELA)
- Custom Image Forensics
- AI Image Authenticity Heuristics

---

# Processing Flow

<img width="874" height="547" alt="diagram-export-13-8-2026-10_13_28-pm" src="https://github.com/user-attachments/assets/5a807070-12bf-4410-a3db-5c4d13bcf50a" />


---

# API Endpoints

| Endpoint | Purpose |
|-----------|---------|
| Upload API | Upload image |
| Status API | Track processing status |
| Results API | Fetch inspection report |
| Retry API | Reprocess failed jobs |

---

# AI Usage Disclosure

AI tools were used for:

- UI scaffolding
- Boilerplate generation
- Architecture brainstorming
- OCR workflow experimentation
- Documentation assistance

All AI-generated code was manually reviewed, validated, tested, and modified where necessary.

Several generated implementations required corrections, including:

- Confidence scoring logic
- Duplicate detection workflow
- OCR failure handling
- Blur detection normalization

---

# Design Decisions & Trade-Offs

## Implemented

- Lightweight asynchronous queue architecture
- Heuristic-based forensic analysis
- Offline RTO decoding
- Explainable scoring system
- Human-readable audit trail

## Future Improvements

- Redis + BullMQ integration
- Vector embedding-based duplicate detection
- Advanced AI forgery detection models
- Automated retry mechanisms
- Distributed worker architecture
- Observability and monitoring dashboards

---

---

# Sample Output

Each inspection generates:

- Vehicle Registration Extraction
- RTO Intelligence Report
- Image Quality Analysis
- Forensic Analysis
- AI Authenticity Assessment
- Trust Score Calculation
- Audit Timeline

### Screenshots

#### Landing Page

<img width="907" height="470" alt="image" src="https://github.com/user-attachments/assets/4b6ac508-c7cf-4924-9a96-49bf778fa621" />


#### Dashboard

<img width="911" height="465" alt="image" src="https://github.com/user-attachments/assets/82e87a99-fea1-47b8-90be-7ed72ccfc399" />


#### Inspection Report

<img width="910" height="461" alt="image" src="https://github.com/user-attachments/assets/bbc63a32-0c20-4b83-87ab-1a8f86ea847d" />


---

# Repository Structure

```text
src/
 ├── routes/
 ├── components/
 ├── lib/
 │   ├── analysis/
 │   ├── ocr/
 │   ├── scoring/
 │   └── pipeline/
 ├── server/
 └── database/

storage/
migrations/
README.md
```

---

# Author

Meghana S

B.Tech Computer Science and Engineering

REVA University

---

