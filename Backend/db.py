"""Schema, connections and seed data for the purchase document POC.

Split out of main.py once the schema grew past two tables. main.py owns HTTP,
this owns storage.
"""

from __future__ import annotations

import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "poc.db"
UPLOAD_DIR = BASE_DIR / "uploads"

# OTHER is the works-contract / RA-bill bucket: classified so it never enters
# the material three-way-match path. Unlike UNCLASSIFIED, a reviewer can't
# approve a document sitting at OTHER either — see extract.mark_approved —
# so a genuine RA bill is filed via reject, not a silent approve, and the
# only way through approval is one of the real kinds below.
#
# INWARD is the site's own material-inward record — a MIN Voucher, in this
# client's own naming — not something the vendor sends, so it never shows
# up with a vendor GSTIN the way INVOICE/DELIVERY do. PURCHASE_BILL is the
# office's own closing record, prepared once the invoice and the MIN both
# reach the office — see po_reconciliation in main.py for how the three tie
# together. DELIVERY stays a real type for whenever a vendor does send a
# dedicated challan, but this client's actual documents don't have one —
# the invoice itself doubles as the delivery record — so it's never
# required, only INVOICE + INWARD + PURCHASE_BILL are.
DOC_TYPES = {
    "UNCLASSIFIED", "INVOICE", "PO", "DELIVERY", "QUOTATION", "INWARD", "PURCHASE_BILL", "OTHER",
}
SOURCES = {"SCAN", "UPLOAD"}
# APPROVED/REJECTED are an accuracy gate on the OCR read, not a business
# validation verdict — the 3-way match (Phase 6) doesn't exist yet. See
# Deviation.md §1.
STATUSES = {"PENDING", "PROCESSING", "EXTRACTED", "APPROVED", "REJECTED", "FAILED"}


SCHEMA = """
PRAGMA foreign_keys = ON;

-- masters --------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  code       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  client     TEXT,
  location   TEXT,
  -- ponytail: the console's one free-text site label. The `sites` table below
  -- is the Phase 5 site master; this is just what the project card prints.
  site       TEXT,
  status     TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sites (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  address    TEXT
);

CREATE TABLE IF NOT EXISTS materials (
  id       TEXT PRIMARY KEY,
  code     TEXT UNIQUE,
  name     TEXT NOT NULL,
  category TEXT,
  unit     TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0   -- 0 = auto-created from a scan
);

-- alias is the primary key: one spelling maps to exactly one material, and
-- INSERT OR IGNORE makes "learn this alias" idempotent.
CREATE TABLE IF NOT EXISTS material_aliases (
  alias       TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vendors (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  gstin    TEXT UNIQUE,
  phone    TEXT,
  verified INTEGER NOT NULL DEFAULT 0
);

-- capture --------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scanner_sessions (
  id            TEXT PRIMARY KEY,
  session_token TEXT UNIQUE NOT NULL,
  created_by    TEXT NOT NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  site_id       TEXT REFERENCES sites(id),
  created_at    TEXT DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  status        TEXT DEFAULT 'ACTIVE'
);

CREATE TABLE IF NOT EXISTS documents (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  site_id        TEXT REFERENCES sites(id),
  session_id     TEXT REFERENCES scanner_sessions(id),
  source         TEXT NOT NULL CHECK (source IN ('SCAN','UPLOAD')),
  -- Set on insert for a SCAN document, cleared the moment the console picks
  -- Process or Draft for the batch it arrived in (see process_batch /
  -- draft_batch in main.py). Every listing filters this out by default, so a
  -- scanned batch the office hasn't looked at yet stays invisible — not
  -- merely unprocessed — until that decision is made. Always 0 for UPLOAD,
  -- which never has anything to decide.
  awaiting_scan_decision INTEGER NOT NULL DEFAULT 0,

  document_type  TEXT NOT NULL DEFAULT 'UNCLASSIFIED'
                 CHECK (document_type IN
                   ('UNCLASSIFIED','INVOICE','PO','DELIVERY','QUOTATION','INWARD','PURCHASE_BILL','OTHER')),
  file_paths     TEXT NOT NULL,
  page_count     INTEGER NOT NULL,
  notes          TEXT,
  is_handwritten INTEGER NOT NULL DEFAULT 0,

  status         TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('DRAFT','PENDING','PROCESSING','EXTRACTED','APPROVED','REJECTED','FAILED')),
  extracted_json TEXT,
  duplicate_of   TEXT REFERENCES documents(id),
  error          TEXT,
  uploaded_at    TEXT DEFAULT (datetime('now'))
);

-- extracted business record ---------------------------------------------------

CREATE TABLE IF NOT EXISTS doc_headers (
  document_id  TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  doc_kind     TEXT,

  doc_number   TEXT,
  po_number    TEXT,
  -- dc_number's meaning depends on doc_kind: on an INVOICE it's the delivery
  -- challan number printed on it (this client rarely has one — the invoice
  -- usually stands in for the challan). On an INWARD (MIN Voucher) or
  -- PURCHASE_BILL, there is no challan — reused for the *invoice* number
  -- that document references instead ("DC/Invoice No" on a real MIN
  -- Voucher), which is the field po_reconciliation groups a MIN/Purchase
  -- Bill under its invoice by.
  dc_number    TEXT,
  -- Which MIN Voucher a PURCHASE_BILL was closed out from — blank on every
  -- other document type. A Purchase Bill references both an invoice (via
  -- dc_number, above) and the MIN that received it; this is the second of
  -- that pair.
  min_number   TEXT,

  doc_date     TEXT,
  doc_date_raw TEXT,

  vendor_id       TEXT REFERENCES vendors(id),
  vendor_name_raw TEXT,
  vendor_gstin    TEXT,
  buyer_gstin     TEXT,

  place_of_supply      TEXT,
  delivery_address_raw TEXT,
  -- The vehicle that actually carried the delivery — printed as "Vehicle
  -- No"/"Truck No"/"Motor Vehicle No" depending on the form. Only ever
  -- meaningful on an INVOICE or an INWARD (MIN Voucher) page — a PO
  -- predates any vehicle, and a Purchase Bill is the office's own closing
  -- record, not something a truck carried.
  vehicle_number TEXT,

  basic_value  REAL,
  tax_type     TEXT CHECK (tax_type IN ('IGST','CGST_SGST')),
  igst_amount  REAL,
  cgst_amount  REAL,
  sgst_amount  REAL,
  tcs_amount   REAL,
  rounding_off REAL,
  total_value  REAL,

  irn         TEXT,
  qr_verified INTEGER NOT NULL DEFAULT 0,

  reviewed_by       TEXT,
  reviewed_at       TEXT,
  rejection_reason  TEXT,
  -- Set only when an already-APPROVED document is reopened and saved again
  -- (the pencil-edit toggle in ReviewModal) — who touched it and when,
  -- kept separate from reviewed_by/reviewed_at so the original approval
  -- itself is never overwritten.
  edited_by         TEXT,
  edited_at         TEXT,

  -- Set only when extract.reconcile_batch silently overwrote a field this
  -- document's own extraction misread — a reference number two sibling
  -- documents uploaded in the same batch both agreed on. Auditable, not
  -- silent: the review screen surfaces this as a banner.
  correction_note TEXT
);

CREATE TABLE IF NOT EXISTS doc_lines (
  id              INTEGER PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL,

  description_raw TEXT NOT NULL,
  material_id     TEXT REFERENCES materials(id),
  hsn_code        TEXT,

  quantity  REAL,
  -- On an INWARD line (a MIN Voucher / material inward note), quantity is
  -- what the note itself calls "MIN Qty" — what was offered for receipt,
  -- not what was actually taken in. accept_qty/reject_qty are that note's
  -- own split of it — a MIN Voucher reports both, not just one number, and
  -- reject_qty is the actual "billed doesn't match what arrived" signal
  -- the three-way match exists for. Null on every other document type's
  -- lines, where quantity alone is the whole story.
  accept_qty REAL,
  reject_qty REAL,
  unit      TEXT,
  rate      REAL,
  amount    REAL,
  tax_rate  REAL,
  dc_number TEXT,
  dc_date   TEXT
);

-- quote analysis -------------------------------------------------------------
-- A vendor's price quotation, not a purchase document — kept out of
-- documents/doc_headers entirely so document_type's CHECK constraint never
-- has to grow (SQLite can't ALTER a CHECK; a fresh table sidesteps it). No
-- approve/reject: comparison across vendors is read-only, so the lifecycle
-- is just PENDING -> PROCESSING -> EXTRACTED/FAILED, same shape as documents
-- minus the review-decision states.

CREATE TABLE IF NOT EXISTS quotations (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  vendor_id       TEXT REFERENCES vendors(id),
  vendor_name_raw TEXT,
  vendor_gstin    TEXT,
  quote_number    TEXT,
  quote_date      TEXT,
  quote_date_raw  TEXT,
  file_paths      TEXT NOT NULL,
  page_count      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','PROCESSING','EXTRACTED','FAILED')),
  error           TEXT,
  uploaded_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotation_lines (
  id              INTEGER PRIMARY KEY,
  quotation_id    TEXT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL,

  description_raw TEXT NOT NULL,
  material_id     TEXT REFERENCES materials(id),
  -- Brand/grade/spec called out separately from the material itself, e.g.
  -- "Fe550D" or "UltraTech OPC 53" — two vendors quoting the same material
  -- can differ here, and folding it into description_raw would break the
  -- alias match every other document type relies on.
  grade_raw       TEXT,
  hsn_code        TEXT,

  quantity REAL,
  unit     TEXT,
  rate     REAL,
  amount   REAL,
  tax_rate REAL
);

-- Which vendor to actually buy a material from, per project — cheapest by
-- default (computed client-side from quotation_lines, nothing stored), but
-- overridable: quality/grade isn't a number extraction can rank, so the
-- person comparing quotes gets the final say per material, not just a
-- reference to look at. One row per (project, material); replacing a pick
-- is an upsert, and cascades away if the picked quotation is deleted.
CREATE TABLE IF NOT EXISTS quote_picks (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  material_id  TEXT NOT NULL REFERENCES materials(id),
  quotation_id TEXT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  picked_by    TEXT,
  picked_at    TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, material_id)
);

-- A document (INVOICE/DELIVERY/INWARD/PURCHASE_BILL) is gone once deleted —
-- documents/doc_headers/doc_lines really are removed, on purpose (see
-- delete_document in main.py) — but po_reconciliation's Delivery Timeline
-- still needs to say "<type> deleted — <time>" for it, including for a
-- delivery every one of whose documents has since been removed. This is a
-- one-way audit trail, not a soft-delete: nothing here is ever read back
-- into a live document, only folded into a Delivery Timeline entry by
-- po_number/doc_number/dc_number the same way a live document would be
-- grouped. No foreign keys — document_id it names is already gone by the
-- time this row is written.
CREATE TABLE IF NOT EXISTS deleted_documents (
  id               INTEGER PRIMARY KEY,
  document_id      TEXT NOT NULL,
  project_id       TEXT,
  document_type    TEXT,
  doc_number       TEXT,
  po_number        TEXT,
  dc_number        TEXT,
  vendor_id        TEXT,
  vendor_name      TEXT,
  uploaded_at      TEXT,
  reviewed_by      TEXT,
  reviewed_at      TEXT,
  edited_by        TEXT,
  edited_at        TEXT,
  rejection_reason TEXT,
  deleted_at       TEXT NOT NULL
);

-- Every "edit an approved document" decision (see update_document in
-- main.py) gets its own row here. doc_headers.edited_by/edited_at still
-- hold only the *latest* one — every other reader of "who last touched
-- this" keeps working unchanged — but the Delivery/Document Timeline reads
-- this table instead, so editing the same document twice adds a second
-- event rather than just moving the first one's timestamp.
CREATE TABLE IF NOT EXISTS document_edits (
  id          INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  edited_by   TEXT NOT NULL,
  edited_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_headers_date ON doc_headers(doc_date);
CREATE INDEX IF NOT EXISTS ix_documents_project ON documents(project_id);
CREATE INDEX IF NOT EXISTS ix_sites_project ON sites(project_id);
CREATE INDEX IF NOT EXISTS ix_quotations_project ON quotations(project_id);
CREATE INDEX IF NOT EXISTS ix_quotation_lines_quotation ON quotation_lines(quotation_id);
CREATE INDEX IF NOT EXISTS ix_quote_picks_project ON quote_picks(project_id);
CREATE INDEX IF NOT EXISTS ix_deleted_documents_po ON deleted_documents(project_id, po_number);
CREATE INDEX IF NOT EXISTS ix_document_edits_doc ON document_edits(document_id);
"""


# Starter list. Unmatched invoice lines auto-create unverified materials on top
# of these, so a gap here never blocks extraction.
MATERIAL_SEED = [
    ("Cement", "OPC Cement 53 Grade", "Bags", ["opc 53", "opc cement 53 grade", "cement opc-53", "opc-53"]),
    ("Cement", "OPC Cement 43 Grade", "Bags", ["opc 43", "opc cement 43 grade", "cement opc-43"]),
    ("Cement", "PPC Cement", "Bags", ["ppc", "portland pozzolana cement"]),
    ("Cement", "White Cement", "Bags", ["white cement"]),
    ("Concrete", "Ready Mix Concrete M20", "Cum", ["m020", "m20", "rmc m20"]),
    ("Concrete", "Ready Mix Concrete M25", "Cum", ["m025", "m25", "rmc m25"]),
    ("Concrete", "Ready Mix Concrete M30", "Cum", ["m030", "m30", "rmc m30", "m030-regular concrete"]),
    ("Steel", "TMT Steel Bar 8mm", "MT", ["tmt 8mm", "8mm tmt", "rebar 8mm"]),
    ("Steel", "TMT Steel Bar 10mm", "MT", ["tmt 10mm", "10mm tmt", "rebar 10mm"]),
    ("Steel", "TMT Steel Bar 12mm", "MT", ["tmt 12mm", "12mm tmt", "rebar 12mm", "steel bar 12"]),
    ("Steel", "TMT Steel Bar 16mm", "MT", ["tmt 16mm", "16mm tmt", "rebar 16mm"]),
    ("Steel", "Binding Wire", "Kg", ["binding wire", "gi binding wire"]),
    ("Steel", "Structural Steel", "MT", ["ms angle", "ms channel", "structural steel"]),
    ("Aggregate", "River Sand", "Tons", ["river sand", "natural sand"]),
    ("Aggregate", "M Sand", "Tons", ["m sand", "manufactured sand", "msand"]),
    ("Aggregate", "20mm Aggregate", "Cum", ["20mm aggregate", "20mm jelly"]),
    ("Aggregate", "40mm Aggregate", "Cum", ["40mm aggregate", "40mm jelly"]),
    ("Masonry", "Red Clay Brick", "Nos", ["red brick", "clay brick", "brick"]),
    ("Masonry", "AAC Block", "Nos", ["aac block", "aerated block"]),
    ("Masonry", "Concrete Solid Block", "Nos", ["solid block", "concrete block", "cc block"]),
    ("Finishing", "Wall Putty", "Bags", ["wall putty", "putty"]),
    ("Finishing", "Emulsion Paint", "Ltr", ["emulsion paint", "emulsion"]),
    ("Waterproof", "Waterproofing Compound", "Kg", ["waterproofing compound", "waterproof chemical"]),
]


@contextmanager
def db():
    """One connection per request.

    FastAPI runs sync endpoints in a threadpool and sqlite3 connections are not
    shareable across threads, so a module-level connection would be a bug.
    """
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        yield con
        con.commit()
    finally:
        con.close()


def new_id(prefix: str) -> str:
    return prefix + "-" + uuid.uuid4().hex[:10]


# poc.db predates several of the columns above — CREATE TABLE IF NOT EXISTS
# leaves an existing table exactly as it was, so a table that already existed
# before a column was added to SCHEMA never gets it. Add what's missing
# instead of asking anyone to delete a database that has real projects in it.
_MIGRATIONS = {
    "projects": [
        ("client", "TEXT"),
        ("location", "TEXT"),
        ("status", "TEXT NOT NULL DEFAULT 'ACTIVE'"),
    ],
    "scanner_sessions": [
        ("site_id", "TEXT REFERENCES sites(id)"),
    ],
    "documents": [
        ("site_id", "TEXT REFERENCES sites(id)"),
        ("source", "TEXT NOT NULL DEFAULT 'UPLOAD'"),
        ("notes", "TEXT"),
        ("is_handwritten", "INTEGER NOT NULL DEFAULT 0"),
        ("extracted_json", "TEXT"),
        ("duplicate_of", "TEXT REFERENCES documents(id)"),
        ("error", "TEXT"),
        ("awaiting_scan_decision", "INTEGER NOT NULL DEFAULT 0"),
    ],
    "doc_headers": [
        ("min_number", "TEXT"),
        ("vehicle_number", "TEXT"),
        ("correction_note", "TEXT"),
        ("edited_by", "TEXT"),
        ("edited_at", "TEXT"),
    ],
    "doc_lines": [
        ("accept_qty", "REAL"),
        ("reject_qty", "REAL"),
    ],
}


def migrate(con: sqlite3.Connection) -> None:
    """Idempotent: only ever adds a column that isn't there yet."""
    for table, columns in _MIGRATIONS.items():
        existing = {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}
        for name, ddl in columns:
            if name not in existing:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")


def migrate_drop_invoice_channel(con: sqlite3.Connection) -> None:
    """SITE/VENDOR invoice copies turned out not to match how this client
    actually works — no such distinction exists on their real documents —
    so the column (and its own inline CHECK) is dropped outright rather
    than just left unused. Idempotent: a no-op once it's gone. Modern
    SQLite (3.35+) can drop a column that carries its own inline CHECK
    constraint directly, no table rebuild needed — verified against this
    project's actual sqlite3 (3.50.4)."""
    existing = {r["name"] for r in con.execute("PRAGMA table_info(doc_headers)")}
    if "invoice_channel" in existing:
        con.execute("ALTER TABLE doc_headers DROP COLUMN invoice_channel")


# The columns documents actually has, by name — not the order SCHEMA lists
# them in above. ALTER TABLE ADD COLUMN always appends, so a database that
# predates some of _MIGRATIONS' columns has them in whatever order they were
# added, not SCHEMA's idealised one. migrate_document_type_check rebuilds by
# name for exactly that reason — a positional `SELECT *` would silently
# scramble columns on any database older than the newest migration.
_DOCUMENT_COLUMNS = (
    "id", "project_id", "site_id", "session_id", "source", "document_type",
    "file_paths", "page_count", "notes", "is_handwritten", "status",
    "extracted_json", "duplicate_of", "error", "uploaded_at",
)


def migrate_document_type_check(con: sqlite3.Connection) -> None:
    """SQLite can't ALTER a CHECK constraint — adding a new valid
    document_type or status needs the table rebuilt. Idempotent: a no-op once
    the table's own stored CREATE TABLE text already allows every type
    DOC_TYPES lists and every status the app uses (checked via the newest
    ones added, 'PURCHASE_BILL' and 'DRAFT', so a database that already has
    one but predates the other still gets rebuilt once more). Must run after
    migrate() — depends on every column above already existing under its
    real name.

    Builds the replacement under a temporary name, copies into it, drops the
    original, then renames the temp table into place — deliberately not the
    other order (rename original out of the way first). Renaming a table
    also rewrites *other* tables' FOREIGN KEY clauses that reference it by
    name, so renaming the original documents table first would repoint
    doc_headers/doc_lines at the soon-to-be-dropped copy instead of the new
    one. This order never renames the table anything else has a live FK to
    — "documents" is only ever the original, or (after the swap) the new
    one, from doc_headers/doc_lines' point of view.
    """
    row = con.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents'"
    ).fetchone()
    if row is None or ("PURCHASE_BILL" in row["sql"] and "DRAFT" in row["sql"]):
        return

    cols = ", ".join(_DOCUMENT_COLUMNS)
    con.execute("PRAGMA foreign_keys = OFF")
    con.execute("""
        CREATE TABLE documents_new (
          id             TEXT PRIMARY KEY,
          project_id     TEXT NOT NULL REFERENCES projects(id),
          site_id        TEXT REFERENCES sites(id),
          session_id     TEXT REFERENCES scanner_sessions(id),
          source         TEXT NOT NULL CHECK (source IN ('SCAN','UPLOAD')),
          document_type  TEXT NOT NULL DEFAULT 'UNCLASSIFIED'
                         CHECK (document_type IN
                           ('UNCLASSIFIED','INVOICE','PO','DELIVERY','QUOTATION','INWARD','PURCHASE_BILL','OTHER')),
          file_paths     TEXT NOT NULL,
          page_count     INTEGER NOT NULL,
          notes          TEXT,
          is_handwritten INTEGER NOT NULL DEFAULT 0,
          status         TEXT NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN
                           ('DRAFT','PENDING','PROCESSING','EXTRACTED','APPROVED','REJECTED','FAILED')),
          extracted_json TEXT,
          duplicate_of   TEXT REFERENCES documents(id),
          error          TEXT,
          uploaded_at    TEXT DEFAULT (datetime('now'))
        )
    """)
    con.execute(f"INSERT INTO documents_new ({cols}) SELECT {cols} FROM documents")
    con.execute("DROP TABLE documents")
    con.execute("ALTER TABLE documents_new RENAME TO documents")
    # The rename carries this index's definition with it, but not its
    # existence if it wasn't created yet — belt and braces either way.
    con.execute("CREATE INDEX IF NOT EXISTS ix_documents_project ON documents(project_id)")
    con.execute("PRAGMA foreign_keys = ON")


def seed_materials(con) -> int:
    """Idempotent: only fills an empty materials table."""
    if con.execute("SELECT 1 FROM materials LIMIT 1").fetchone():
        return 0

    for category, name, unit, aliases in MATERIAL_SEED:
        material_id = "MAT-" + name.upper().replace(" ", "-")
        con.execute(
            "INSERT INTO materials (id, code, name, category, unit, verified)"
            " VALUES (?, ?, ?, ?, ?, 1)",
            (material_id, material_id, name, category, unit),
        )
        # The canonical name is itself an alias, so an exact-name hit needs no
        # special case in the matcher.
        for alias in {name.lower(), *aliases}:
            con.execute(
                "INSERT OR IGNORE INTO material_aliases (alias, material_id) VALUES (?, ?)",
                (alias, material_id),
            )
    return len(MATERIAL_SEED)


def init() -> None:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with db() as con:
        con.executescript(SCHEMA)
        migrate(con)
        migrate_document_type_check(con)
        migrate_drop_invoice_channel(con)
        seed_materials(con)
