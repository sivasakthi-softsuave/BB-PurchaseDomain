# Construction Purchase Document Intelligence — POC

Site staff photograph invoices, purchase orders and delivery challans with a phone. The system
extracts the fields, maps each purchase to the right project / site / material, validates the
invoice against its PO and delivery document, and the office team approves or rejects the result.

Replaces manual purchase data entry and manual three-way matching.

---

## Repository layout

```
Purchase-Division-POC/
├── Backend/     FastAPI + SQLite + local file uploads
│   ├── main.py            HTTP only — tokens, endpoints, QR page
│   ├── db.py              schema, connections, material/vendor seed data
│   ├── extract.py         classify + extract (Claude vision), map, persist
│   ├── requirements.txt
│   └── uploads/           scans land here, per session dir (gitignored)
├── FE/
│   └── index.html         the QR / connect page served at GET /
├── Mobile/      Expo + TypeScript Android scanner
│   ├── App.tsx            native-stack navigator
│   └── src/
│       ├── store.ts       zustand — serverUrl, token, sessionId, queue[]
│       ├── api.ts         checkHealth(), batchUpload()
│       ├── theme.ts, ui.tsx
│       └── screens/       Connect · QRScanner · Camera · Preview · Queue
├── Sample/      reference documents from the client (gitignored)
└── fixtures/    document sets + expected.json (Phase 1, not yet populated)
```

Planning documents: `Construction_Purchase_Document_Intelligence_Prototype_Plan.md` (business scope)
and `Implementation_Plan_Phasewise.md` (build order, decisions, per-phase deliverables).

---

## How a document flows

```
phone  ──▶ POST /api/v1/documents/batch-upload   (session token, pages grouped)
browser ─▶ POST /api/v1/documents/upload         (project_id, one file per document)
                        │
                        ▼
              stored on disk, row = PENDING, type = UNCLASSIFIED
                        │  background task
                        ▼
        extract.run_engine()  one Claude vision call per document
        ├─ classifies  INVOICE · PO · DELIVERY · OTHER (RA bills)
        └─ transcribes header + line items, verbatim
                        │
                        ▼
        mapped: date parsed day-first, GSTIN validated, material and vendor
        matched via alias tables (unknowns auto-created, unverified),
        duplicate flagged by vendor GSTIN + document number
                        │
                        ▼
              doc_headers + doc_lines, row = EXTRACTED
                        │  POST /documents/{id}/review
                        ▼
              REVIEWED — a corrected material mapping is learned as an alias
```

Nothing in the pipeline blocks on missing masters: an unknown material or vendor is created
unverified rather than rejected, and an unparseable date keeps its raw string for review.

## Status

| # | Phase | Builds | Status |
|---|---|---|---|
| 1 | Fixtures | 13 authored sets + sourced docs + masters + `rules.json` | Not started |
| 2 | Data foundation | `scanner_sessions`, `documents` | **Done** |
| 3 | Scanner + upload API | `Backend/main.py`, `FE/index.html`, `Mobile/` 5 screens | **Done** |
| 4 | Extraction | `Backend/db.py`, `Backend/extract.py` — classifier + field schema | **Done** |
| 5 | Mapping | Masters, 6-rung linkage chain, alias tables | Material + vendor mapping done; site/PO linkage next |
| 6 | Validation | `validate()` + 9 checks + fixture test suite | Blocked on 1 + 5 |
| 7 | Review web app | `FE/` dashboard, review, auth, audit | Blocked on 6 |
| 8 | Purchase records | `purchases` table + rollup views | Blocked on 7 |
| 9 | Dashboard + evaluation | Stats, audit trail, accuracy report | Blocked on 8 |

---

## Running it

**Requires** Python 3.12 · Node 24 · an Android phone with [Expo Go], on the **same Wi-Fi**
as the dev machine.

[Expo Go]: https://expo.dev/go

### First-time setup after a clone

Two env files, neither in git. Copy the templates beside them and fill in the keys — the
templates document every variable, defaults included:

```bash
cp Backend/.env.example Backend/.env     # API key, session key
cp FE/.env.example FE/.env               # console feature flags
```

Nothing else is missing: the SQLite schema, `poc.db` and `uploads/` all create themselves on
first run.

### Backend

```bash
cd Backend
pip install -r requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

`--host 0.0.0.0` is not optional — bound to localhost the phone cannot reach it. The startup
banner prints the LAN URL to open.

Extraction needs a vision API key (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, whichever matches
`EXTRACT_PROVIDER`). Without one, uploads still store fine and each document lands `FAILED`
with the reason — nothing crashes, and `POST /api/v1/documents/{id}/extract` re-runs it once a
key is set.

| Env var | Default | Purpose |
|---|---|---|
| `EXTRACT_PROVIDER` | `anthropic` | Which vision engine reads documents — `anthropic` or `openai` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | — | Credentials for that provider. Unset = every document fails |
| `EXTRACT_MODEL` | `claude-opus-5` / `gpt-4o-mini` | Routine first-pass model |
| `EXTRACT_MODEL_THOROUGH` | `claude-opus-5` / `gpt-4o` | Bigger model used by "Re-read this document" |
| `SECRET_KEY` | `dev-insecure-key` | HMAC key for session tokens |
| `SESSION_TTL` | `900` | Token lifetime, seconds |
| `HOST_IP` | auto-detected | LAN IP advertised in the QR — set it on machines with Docker/VM adapters |
| `PORT` | `8000` | Port advertised in the QR |

### Console (FE)

```bash
cd FE
npm install
npm run dev      # dev server on :5173, proxied to the backend
npm run build    # emits FE/dist/, which the backend serves at /
```

### Mobile

```bash
cd Mobile
npm install
npx expo start
```

Scan the Metro QR with Expo Go to load the app. That is a *different* QR from the connect QR
served by the backend — Metro's loads the app, the backend's authenticates the session.

If Expo Go fails to load the bundle (`Failed to download remote update` / `Something went
wrong`), the phone can't reach Metro directly — different subnet, guest-Wi-Fi client isolation,
or a firewall blocking port 8081. Run `npm run start:tunnel` instead (routes through ngrok,
`@expo/ngrok` is already a dev dependency) so Expo Go loads over any network, not just the local
one. Slower than LAN — use plain `npx expo start` when the phone genuinely is on the same Wi-Fi.

---

## The flow

1. Office opens `http://<host-ip>:8000/` — the backend mints a 15-minute session and renders its
   QR. Refreshing the page mints a fresh one.
2. Site worker opens the app → **Scan QR to Connect** → the payload carries `serverUrl` +
   `sessionToken`, which is verified against `GET /api/v1/health` before proceeding.
3. Camera → capture → Preview. **+ Add page** captures another image into the *same* queue entry;
   Add to Queue starts a new document. Document type and notes are per document, not per page.
4. Queue shows `Invoice (2 pages)`, `PO (1 page)` → **Send All** → one multipart request.
5. Files land in `Backend/uploads/<session_id>/` as `{doc_uuid}_p{n}.jpg`, one `documents` row per
   document with `status = PENDING`.

### API

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /` | none | Creates a session, renders the connect QR |
| `POST /api/v1/sessions` | none | Create session, return `qr_payload` |
| `GET /api/v1/health` | bearer | Connection check after QR scan |
| `POST /api/v1/documents/batch-upload` | bearer | **Main endpoint** — N files + metadata |
| `GET /api/v1/documents` | none | List documents |
| `GET /api/v1/documents/{id}` | none | Single document |

Interactive docs at `/docs`.

**Upload contract** — `files` is flat and consumed in order; `metadata` is one entry per document:

```
files[]  → [inv_p1.jpg, inv_p2.jpg, po.jpg]
metadata → [{"document_type":"INVOICE","notes":"","page_count":2},
            {"document_type":"PO","notes":"","page_count":1}]
```

Rejected with **400** when `sum(page_count) != len(files)`, when `document_type` is outside
`INVOICE | PO | DELIVERY`, or when `metadata` is not valid JSON. The client's filename is never
used as a path — only its extension, and only from a whitelist.

**Session token** — `base64({sid, exp}) . base64(hmac_sha256(payload, SECRET_KEY))`, verified with
`hmac.compare_digest`. 15-minute TTL. A JWT library would be a crypto dependency for fifteen lines.

---

## Verification

Token logic self-check — forged signature, swapped payload, malformed, expired:

```bash
python Backend/main.py        # → "token self-check passed"
```

Backend alone, before touching the phone:

```bash
TOKEN=$(curl -s -X POST localhost:8000/api/v1/sessions | python -c 'import json,sys;print(json.load(sys.stdin)["session_token"])')

curl -s localhost:8000/api/v1/health -H "Authorization: Bearer $TOKEN"   # → {"status":"ok",...}
curl -s localhost:8000/api/v1/health -H "Authorization: Bearer bogus"    # → 401

curl -s -X POST localhost:8000/api/v1/documents/batch-upload \
     -H "Authorization: Bearer $TOKEN" \
     -F 'files=@inv_p1.jpg' -F 'files=@inv_p2.jpg' -F 'files=@po.jpg' \
     -F 'metadata=[{"document_type":"INVOICE","notes":"","page_count":2},
                   {"document_type":"PO","notes":"","page_count":1}]'

sqlite3 Backend/poc.db 'select document_type,page_count,status from documents;'  # → 2 rows: 2 and 1
```

Full loop: open `/` → QR renders → Expo Go → Connect → capture an invoice, **+ Add page**,
capture page 2, Add to Queue → capture a PO → Queue shows `Invoice (2 pages)` and `PO (1 page)`
→ Send All → **2 rows** in `documents`, **3 files** in `uploads/`.

---

## Scope decisions

| Decision | Choice | Why |
|---|---|---|
| Document scope | **Material supply invoices only** | Works-contract / RA bills carry no quantity and no unit rate, so three-way matching is structurally impossible. Classified and routed to manual review. |
| e-Invoice QR decoding | **No** — printed fields only | Client's call. |
| Multi-page documents | Grouped in the queue | One entry, N page images. The reference invoice is 2 pages. |
| Extraction provider | Decided in Phase 4 | Against measured accuracy on real fixtures, not up front. |
| Validation tolerances | **Our assumptions** | No client documents were available. Flagged for sign-off at the demo — a wrong tolerance makes validation confidently wrong. |

## Not in the POC

No Docker, CI, Postgres, S3, or Celery/Redis — all one-step swaps later, none make the demo work
sooner. No cloud deployment; the backend runs on a laptop on the site Wi-Fi (`ngrok http 8000` for
a remote demo, the QR picks up the tunnel URL). **No offline queue on mobile** — if the site Wi-Fi
does not reach the backend, scanning is blocked. That is a real site constraint worth raising with
the client early, not a shortcut.
