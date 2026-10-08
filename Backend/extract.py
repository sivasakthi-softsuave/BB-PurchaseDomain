"""Extraction and mapping.

The OCR engine is not chosen yet, so it lives behind exactly one function —
`run_engine`. Everything else here (date parsing, material and vendor mapping,
duplicate detection, persistence) is engine-agnostic and already testable.

Run `python extract.py` for the self-check.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel

import media
import ocr
from db import BASE_DIR, DOC_TYPES, db, new_id

try:
    import anthropic
except ImportError:          # the rest of this module is engine-agnostic and
    anthropic = None         # stays importable — and testable — without the SDK.

try:
    import openai
except ImportError:
    openai = None


class EngineNotConfigured(RuntimeError):
    """Raised until an OCR engine is wired in."""


# ── dates ────────────────────────────────────────────────────────────────────
# Indian documents print dates day-first. The samples alone carry three shapes:
# "08.08.2023" (UltraTech) and "05-Mar-2020" (the PO and challan).
#
# The trap: "05/03/2026" is 5 March here and 3 May in the US. A model trained on
# US data flips it silently, landing the invoice in the wrong month and the wrong
# GST period with nothing appearing broken. So day-first is not a preference, it
# is the rule, and %m/%d is never attempted.

_DATE_FORMATS = (
    "%Y-%m-%d",     # ISO, in case the engine already normalised it
    "%d.%m.%Y",     # 08.08.2023
    "%d/%m/%Y",     # 08/08/2023
    "%d-%m-%Y",     # 08-08-2023
    "%d-%b-%Y",     # 05-Mar-2020
    "%d %b %Y",     # 05 Mar 2020
    "%d-%B-%Y",     # 05-March-2020
    "%d %B %Y",     # 05 March 2020
    "%d.%m.%y",     # 08.08.23
    "%d/%m/%y",
    "%d-%m-%y",
)


def parse_date(raw: str | None) -> str | None:
    """Printed date to ISO YYYY-MM-DD, day-first. None if unparseable.

    Unparseable is not an error — the raw string is stored alongside and a human
    fixes it in review.
    """
    if not raw:
        return None
    text = " ".join(str(raw).split())
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return None


# ── text normalisation ───────────────────────────────────────────────────────

def normalise(text: str | None) -> str:
    """Lowercase, collapse whitespace, drop surrounding punctuation."""
    if not text:
        return ""
    return " ".join(str(text).lower().split()).strip(" .,:;-")


# 2-digit state code + 10-character PAN (5 letters, 4 digits, 1 letter) + entity
# digit + 'Z' + checksum.
GSTIN_RE = re.compile(r"\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z0-9]{2}\b")

# Fallback: anything 15 characters starting with two digits. A single OCR slip
# breaks the strict pattern, and returning None there would throw away the only
# vendor identifier on the page. Better to surface a suspect value a human can
# fix than to silently lose it.
GSTIN_LOOSE_RE = re.compile(r"\b\d{2}[A-Z0-9]{13}\b")


def find_gstin(text: str | None) -> str | None:
    """Pull a GSTIN out of free text. Strict shape first, loose shape second."""
    if not text:
        return None
    upper = str(text).upper()
    match = GSTIN_RE.search(upper) or GSTIN_LOOSE_RE.search(upper)
    return match.group(0) if match else None


def is_valid_gstin(value: str | None) -> bool:
    """True only for the strict shape — drives the confidence flag in review."""
    return bool(value and GSTIN_RE.fullmatch(str(value).upper()))


_GSTIN_CHECKSUM_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_checksum_ok(value: str | None) -> bool | None:
    """Verifies the real check digit (char 15) against chars 1-14 — catches a
    single misread character with certainty, unlike the shape-only regex
    check above. None (not True/False) when there's nothing 15-chars long to
    check at all, so a caller can tell "not validated" from "validated and
    wrong"."""
    if not value or len(value) != 15:
        return None
    value = value.upper()
    total = 0
    factor = 1
    for ch in value[:14]:
        code = _GSTIN_CHECKSUM_CHARS.find(ch)
        if code == -1:
            return None
        d = factor * code
        d = (d // 36) + (d % 36)
        total += d
        factor = 2 if factor == 1 else 1
    expected = _GSTIN_CHECKSUM_CHARS[(36 - (total % 36)) % 36]
    return value[14] == expected


# B&B's own PAN — chars 3-12 of any GSTIN they hold, in any state (the state
# code and check digit vary per registration, this doesn't). Confirmed
# against every real sample this session: 33AADCB4217G1Z6 (Tamil Nadu),
# 21AADCB4217G1ZB (Odisha), 34AADCB4217G1Z4 (Puducherry) all share it.
_SELF_PAN = "AADCB4217G"


def gstin_is_self(value: str | None) -> bool:
    """True when a GSTIN belongs to B&B itself, or is within 2 misread
    characters of one — a real instance had the buyer/vendor mixup *and* a
    transposed character on top (AACDB vs AADCB), so an exact match alone
    missed it. On vendor_gstin this is almost always a buyer/vendor mixup —
    B&B is never its own supplier."""
    if not value or len(value) != 15:
        return False
    pan = value[2:12].upper()
    diff = sum(1 for a, b in zip(pan, _SELF_PAN) if a != b)
    return diff <= 2


# ── mapping ──────────────────────────────────────────────────────────────────

def match_material(
    con: sqlite3.Connection, description: str | None, unit: str | None = None,
    ai_matched_id: str | None = None,
) -> str | None:
    """Description to material_id via the alias table, creating one if needed.

    Line descriptions carry spec sub-lines — the samples show "Electric Drill
    Machine / 10mm / 300W" as one cell. The first line is the material name, so
    try the whole block first and then just that line.

    ai_matched_id is the engine's own semantic pick (Line.matched_material_id
    — see the SYSTEM prompt's catalog rule): the model recognised this line as
    a material already on the verified catalog, worded differently than
    whatever alias is on file for it. The alias table stays the source of
    truth going forward — a hit there always wins, exact text being the
    cheapest and least error-prone match there is — but on a genuine miss, a
    validated AI pick is preferred over inventing a new unverified material
    for a delivery this client already has a real record of.
    """
    text = normalise(description)
    if not text:
        return None

    candidates = [text]
    first_line = normalise(str(description).splitlines()[0])
    if first_line and first_line != text:
        candidates.append(first_line)

    for candidate in candidates:
        row = con.execute(
            "SELECT material_id FROM material_aliases WHERE alias = ?", (candidate,)
        ).fetchone()
        if row:
            return row["material_id"]

    # A trusted catalog id, not a free-form guess: only ever one of the
    # verified rows actually offered to the model (see _material_catalog_block)
    # — a hallucinated id fails this existence check and falls through to
    # creating a new material below, same as if ai_matched_id were never given.
    if ai_matched_id:
        exists = con.execute(
            "SELECT 1 FROM materials WHERE id = ? AND verified = 1", (ai_matched_id,)
        ).fetchone()
        if exists:
            learn_material_alias(con, candidates[-1], ai_matched_id)
            return ai_matched_id

    # Never block on a masters gap: create it unverified and let review confirm.
    # The line's own unit wins when the document printed one; "Nos" is only a
    # fallback for lines that carry no unit at all (a PO or RA bill line).
    material_id = new_id("MAT")
    label = str(description).splitlines()[0].strip()[:120]
    con.execute(
        "INSERT INTO materials (id, code, name, category, unit, verified)"
        " VALUES (?, NULL, ?, NULL, ?, 0)",
        (material_id, label, (unit or "").strip() or "Nos"),
    )
    con.execute(
        "INSERT OR IGNORE INTO material_aliases (alias, material_id) VALUES (?, ?)",
        (candidates[-1], material_id),
    )
    return material_id


def learn_material_alias(con: sqlite3.Connection, description: str, material_id: str) -> None:
    """Called when a human corrects a mapping in review.

    This is the whole learning mechanism: the next document using that wording is
    an exact hit. No model involved — an INSERT.
    """
    alias = normalise(description)
    if not alias:
        return
    con.execute(
        "INSERT INTO material_aliases (alias, material_id) VALUES (?, ?)"
        " ON CONFLICT(alias) DO UPDATE SET material_id = excluded.material_id",
        (alias, material_id),
    )


def match_vendor(con: sqlite3.Connection, name: str | None, gstin: str | None) -> str | None:
    """GSTIN is canonical; fall back to an exact name match, else auto-create.

    Vendors need no alias table — the government already assigned every
    registered supplier a unique identifier.
    """
    gstin = find_gstin(gstin) or find_gstin(name)

    if gstin:
        row = con.execute("SELECT id FROM vendors WHERE gstin = ?", (gstin,)).fetchone()
        if row:
            return row["id"]

    clean_name = (name or "").strip()
    if clean_name:
        row = con.execute(
            "SELECT id FROM vendors WHERE lower(name) = ?", (clean_name.lower(),)
        ).fetchone()
        if row:
            # Learn the GSTIN so the next document is an exact identifier hit.
            if gstin:
                con.execute(
                    "UPDATE vendors SET gstin = COALESCE(gstin, ?) WHERE id = ?",
                    (gstin, row["id"]),
                )
            return row["id"]

    if not clean_name and not gstin:
        return None

    vendor_id = new_id("VEN")
    con.execute(
        "INSERT INTO vendors (id, name, gstin, verified) VALUES (?, ?, ?, 0)",
        (vendor_id, clean_name or gstin, gstin),
    )
    return vendor_id


def find_duplicate(
    con: sqlite3.Connection, vendor_id: str | None, doc_number: str | None, exclude_id: str
) -> str | None:
    """Same project, same vendor, same document number, different scan.

    Invoice numbers are per-vendor sequences — "136" and "32" in the samples — so
    the number alone collides constantly. Vendor plus number is the real key —
    but only within the one project exclude_id itself belongs to. Two entirely
    different jobs can each legitimately have their own invoice sharing that
    same vendor + number (or even be billed the exact same delivery under two
    different POs), and pairing across that boundary previously showed a
    reviewer on a brand-new project a "matches its other copy" banner pointing
    at a completely unrelated project's document — scoped here the same way
    po_reconciliation already scopes its own vendor+number grouping.

    Matched on vendor_id — match_vendor's resolved identity — not the raw
    vendor_gstin text this specific page happened to carry. A vendor+number
    pairing has to survive the model simply missing the GSTIN on one of the
    two copies (a blurry stamp, a scan it just drops a field on): match_vendor
    already resolves that copy to the same vendor row by name, so keying off
    vendor_id here still pairs the two, where matching on raw GSTIN text would
    silently fail to pair them (see a real instance of exactly this in
    po_reconciliation's own docstring).
    """
    if not vendor_id or not doc_number:
        return None
    row = con.execute(
        "SELECT h.document_id FROM doc_headers h"
        " JOIN documents d ON d.id = h.document_id"
        " WHERE d.project_id = (SELECT project_id FROM documents WHERE id = ?)"
        " AND h.vendor_id = ? AND h.doc_number = ? AND h.document_id != ?"
        " ORDER BY h.rowid LIMIT 1",
        (exclude_id, vendor_id, doc_number, exclude_id),
    ).fetchone()
    return row["document_id"] if row else None


# ── reconciliation ───────────────────────────────────────────────────────────
# Two documents that find_duplicate paired (same vendor GSTIN + document
# number) are meant to be the same delivery billed twice through different
# channels — a paper copy to the site, a separate copy emailed to head
# office. Genuinely being the same paper, there is no legitimate reason for
# their line items to disagree, unlike an invoice against its PO, where day-
# to-day price movement is expected. No DB access here — the caller joins in
# material_name and hands in the two line lists, so this stays a pure,
# independently testable function.

RATE_TOLERANCE = 0.01
# Both comparisons below are against numbers that went through a division or
# a running sum (aggregate_by_material's rate and qty), so two values a
# person would call identical can differ by a float's last bit — a genuine
# ₹0.01 gap sits at 0.010000000000218279 in IEEE754, not 0.01 exactly, and
# a plain "<= RATE_TOLERANCE" rejects it. This buffer absorbs that rounding
# noise; it is not a second, looser business tolerance.
_EPS = 1e-9


def aggregate_by_material(lines: list[dict]) -> tuple[dict[str, dict], list[dict]]:
    """One document's lines collapsed to one entry per material — summing
    quantity (the same material split across several rows on one invoice is
    still one delivered amount) and taking the quantity-weighted average rate,
    so a material billed on more than one row still reduces to one comparable
    number. Lines that never resolved to a material_id come back separately —
    reported as unmatched, never silently dropped or coincidentally paired."""
    by_material: dict[str, dict] = {}
    unmatched: list[dict] = []
    for line in lines:
        material_id = line.get("material_id")
        qty = line.get("quantity") or 0
        rate = line.get("rate")
        amount = line.get("amount")
        if amount is None and rate is not None:
            amount = qty * rate
        if not material_id:
            unmatched.append(line)
            continue
        entry = by_material.setdefault(material_id, {
            "material_id": material_id, "material_name": line.get("material_name"),
            "unit": line.get("unit"), "qty": 0.0, "amount": 0.0,
        })
        if not entry["unit"]:
            entry["unit"] = line.get("unit")
        entry["qty"] += qty
        entry["amount"] += amount or 0
    for entry in by_material.values():
        entry["rate"] = round(entry["amount"] / entry["qty"], 2) if entry["qty"] else None
    return by_material, unmatched


def compare_document_lines(
    lines_a: list[dict], lines_b: list[dict], *, require_rate: bool = True
) -> dict:
    """Line-by-line diff between two documents believed to be the same
    delivery. `match` on a line is False the moment quantity differs at all,
    rate differs by more than a cent of rounding, or the material is present
    on only one side.

    require_rate=False drops the rate check entirely, down to a quantity-only
    match — for a pairing where one side is never priced at all (a MIN
    Voucher has no rate column to disagree on), requiring rate agreement
    would flag every single line as a mismatch regardless of whether the
    quantities actually agree, which is the thing this comparison actually
    exists to catch."""
    by_a, unmatched_a = aggregate_by_material(lines_a)
    by_b, unmatched_b = aggregate_by_material(lines_b)

    diff_lines = []
    for material_id in sorted(set(by_a) | set(by_b)):
        a, b = by_a.get(material_id), by_b.get(material_id)
        rate_ok = not require_rate or (
            a and b and a["rate"] is not None and b["rate"] is not None
            and abs(a["rate"] - b["rate"]) <= RATE_TOLERANCE + _EPS
        )
        qty_ok = bool(a and b and abs(a["qty"] - b["qty"]) <= _EPS)
        match = bool(a and b and qty_ok and rate_ok)
        diff_lines.append({
            "material_id": material_id,
            "material_name": (a or b)["material_name"],
            "qty_a": a["qty"] if a else None, "rate_a": a["rate"] if a else None,
            "qty_b": b["qty"] if b else None, "rate_b": b["rate"] if b else None,
            "match": match,
        })

    return {
        "lines": diff_lines,
        "unmatched_a": [{"description_raw": l.get("description_raw")} for l in unmatched_a],
        "unmatched_b": [{"description_raw": l.get("description_raw")} for l in unmatched_b],
        "clean": all(d["match"] for d in diff_lines) and not unmatched_a and not unmatched_b,
    }


# ── the engine ───────────────────────────────────────────────────────────────
# One Claude vision call per document does classification and extraction
# together. A separate classifier pass would read the same pixels twice to
# answer a question the extraction already answers.

PROVIDER = os.environ.get("EXTRACT_PROVIDER", "anthropic").strip().lower()
_DEFAULT_MODELS = {"anthropic": "claude-opus-5", "openai": "gpt-4o-mini"}
MODEL = os.environ.get("EXTRACT_MODEL", _DEFAULT_MODELS.get(PROVIDER, "claude-opus-5"))

# What a re-read runs on. A re-read is deliberate, rare and user-triggered —
# somebody has looked at a page the routine pass got wrong and asked for
# another attempt — so it is the one place worth spending a bigger model and
# real thinking budget on. Re-running the *same* small model over the same
# pixels is close to a coin flip; running a stronger one, told exactly which
# fields are provably wrong, is a genuinely different attempt.
_DEFAULT_THOROUGH_MODELS = {"anthropic": "claude-opus-5", "openai": "gpt-4o"}
THOROUGH_MODEL = os.environ.get(
    "EXTRACT_MODEL_THOROUGH", _DEFAULT_THOROUGH_MODELS.get(PROVIDER, MODEL)
)
# Only used on the anthropic path — how hard a re-read is told to think, as
# against the adaptive budget a routine read picks for itself.
THOROUGH_THINKING_TOKENS = int(os.environ.get("EXTRACT_THOROUGH_THINKING", "10000"))



class Line(BaseModel):
    """One row of the line-item table.

    Every field is nullable: an RA bill has no quantity and no rate, and a
    delivery challan has no amount.
    """
    description_raw: str | None
    # This line's material, matched against the reference catalog appended to
    # the prompt below — filled with that entry's own id when you recognise
    # this line names the same real-world material, even under a completely
    # different name ("OPC" is Ordinary Portland Cement, "TMT 12mm" is a TMT
    # Steel Bar 12mm). Left null whenever you are not genuinely sure, or
    # nothing on the list is actually the same material — a document's own
    # unmatched materials still get filed correctly without this field, so a
    # cautious null costs nothing, and a wrong guess here would misfile a
    # delivery against the wrong material's running total.
    matched_material_id: str | None
    hsn_code: str | None
    quantity: float | None
    # A MIN Voucher / material inward note's own split of what it offered
    # for receipt — quantity above is "MIN Qty" on that document, these are
    # its "Accept Qty"/"Reject Qty" columns. Only an INWARD page has these
    # printed; null on every other document type's lines, same as amount is
    # null on a delivery challan. See save_extraction for the doc_kind gate.
    accept_qty: float | None
    reject_qty: float | None
    unit: str | None
    rate: float | None
    amount: float | None
    tax_rate: float | None
    dc_number: str | None
    dc_date_raw: str | None


class Extraction(BaseModel):
    """The engine's contract. Mirrors doc_headers + doc_lines."""
    # Nullable, like every other field here — but still required in the JSON
    # sense (the key must be present); see the self-check's schema assertion.
    # A genuinely unreadable-as-any-of-the-four page returns null rather than
    # a forced guess; save_extraction() already treats anything not in
    # DOC_TYPES as UNCLASSIFIED, so this needed no change there.
    doc_kind: Literal["INVOICE", "PO", "DELIVERY", "QUOTATION", "INWARD", "PURCHASE_BILL", "OTHER"] | None

    doc_number: str | None
    po_number: str | None
    # See doc_headers.dc_number in db.py — a real delivery challan number on
    # an INVOICE, but reused as "the invoice this references" on an INWARD
    # or PURCHASE_BILL page, which never has a challan of their own.
    dc_number: str | None
    # Which MIN Voucher a PURCHASE_BILL was closed out from — the second of
    # the two documents it references (dc_number, above, is the first: the
    # invoice). Null on every other doc_kind.
    min_number: str | None
    doc_date_raw: str | None

    vendor_name_raw: str | None
    vendor_gstin: str | None
    buyer_gstin: str | None

    place_of_supply: str | None
    delivery_address_raw: str | None
    # The truck that carried the delivery — only ever present on an INVOICE
    # or an INWARD (MIN Voucher) page. Null on every other doc_kind.
    vehicle_number: str | None

    basic_value: float | None
    tax_type: Literal["IGST", "CGST_SGST"] | None
    igst_amount: float | None
    cgst_amount: float | None
    sgst_amount: float | None
    tcs_amount: float | None
    rounding_off: float | None
    total_value: float | None

    irn: str | None

    lines: list[Line]


# Every rule below exists because a real sample page broke the naive reading of
# it. Findings 1-6 in Implementation_Plan_Phasewise.md § 3 are the source.
SYSTEM = """You read photographs and scans of Indian construction purchase documents \
and transcribe them. You are a transcriber, not an analyst.

Classify the document as doc_kind:
  INVOICE    a tax invoice for supplied materials — has quantities and unit rates
  PO         a purchase order the buyer issued
  DELIVERY   a delivery challan or goods-received note
  QUOTATION  a vendor's price quotation or rate offer — rates offered, not yet
             transacted; typically no GST breakup and no delivery details,
             often carrying a validity period ("valid for N days")
  INWARD     a material inward report the *site* prepares on receiving a
             delivery — not something the vendor sends. No vendor
             letterhead, no tax breakup; it lists what actually arrived,
             signed or initialled by site staff, not the supplier. If it
             carries a vendor letterhead and GST details, it is a DELIVERY
             challan instead, not this. This client calls it a "MIN
             Voucher" / "Material Inward Note" — a heading with a "MIN
             No"/"MIN Date" instead of the generic name above — treat that
             heading as INWARD, not as unrecognised or OTHER.
  PURCHASE_BILL  the office's own closing record, prepared after both the
             invoice and the MIN Voucher reach it — never sent by the
             vendor, never prepared on site. Heading reads "PURCHASE BILL
             VOUCHER" (or similar); carries its own PV No/PV Date, and
             references a PO No, a MIN No and an Invoice No together on one
             page — that combination (referencing both a MIN and an
             invoice by number) is what tells this apart from an INWARD
             page, which only ever references an invoice, never a MIN.
  OTHER      a document you can positively identify as a specific different
             genre — most often a works-contract / RA bill: a lump sum against
             a BOQ or Work Order with no quantity and no unit rate, which is
             how you recognise it. That absence is the test — a page listing
             material, quantity, rate and amount is never OTHER by this test,
             no matter how it's formatted. OTHER is a positive identification
             of a specific genre, never a fallback for "not sure" — a messy
             page, handwriting, no letterhead, or no printed heading is not by
             itself grounds for OTHER. That case is null, below.
  null       the correct answer whenever you cannot confidently place a
             document as INVOICE, PO, DELIVERY, QUOTATION, INWARD,
             PURCHASE_BILL, or positively as OTHER — illegible handwriting,
             no letterhead, no printed heading, torn, ambiguous, blank, or
             otherwise carrying nothing that identifies which kind it is. A
             human reviewer decides instead. This is not rare and not a
             last resort: if you are genuinely unsure, null is the right
             answer, not OTHER — when torn between OTHER and null
             specifically, choose null. The only wrong use of null is
             ducking a page that legibly *is* one of the seven above.

  Example: a handwritten notebook page listing materials with quantity, rate
  and amount, no letterhead, no vendor name, no "Invoice"/"PO"/"Delivery"
  heading — this is null. It has the qty+rate+amount shape the OTHER/RA-bill
  test rules out, and nothing on the page says which named kind it is, so
  OTHER and every named kind are wrong; only null is correct.

Rules:
- Read every field twice before committing it: once for what the printed
  character actually is, once cross-checked against its own label and the
  values sitting around it — a unit against its quantity, a reference
  number's prefix against which field that prefix means (see the prefix
  table below), a line's amount against its own rate x quantity, a total
  against the figures above it. Most misreads are legible on a second,
  deliberate look — an 8 is not a 3, a v is not a y, "MIN" is not "MN". Work
  the whole page this way before answering, not field by field in isolation.
- Transcribe what is printed. Never infer, calculate or complete a value. If a
  field is not on the page, return null. A wrong value is far worse than null:
  null is visibly missing and gets fixed in review, a wrong value is not.
- Dates: copy the characters exactly as printed ("08.08.2023", "05-Mar-2020")
  into the *_raw fields. Do not reformat or reorder them. Indian documents are
  day-first and the server parses them; reordering here corrupts the date
  silently.
- Amounts: digits only. No currency symbol, no thousands separator. Keep the
  decimals as printed.
- This client's own reference numbers (never a vendor's) each have a fixed
  prefix on the value itself, which settles which field a number belongs in
  even when a label is smudged, rotated, or in a language you're unsure of:
    PO number        always starts "PO"  — e.g. PO/02754/26-27
    MIN Voucher No   always starts "MIN" — e.g. MIN/06586/26-27
    Purchase Bill No always starts "PB"  — e.g. PB/04711/26-27 — even though
                      the label printed next to it usually reads "PV No", not
                      "PB No"; go by the value's own prefix, not the label.
  An invoice number is the one exception: it is assigned by whichever vendor
  issued that invoice, so it carries no fixed prefix or shape at all and
  varies from vendor to vendor. The only reliable way to identify it is the
  printed label itself — wherever a value sits next to "Invoice No" (or
  "Invoice No.", "Inv No"), that value is the invoice number, regardless of
  what it looks like.
- doc_number is this document's own identifying number — go by doc_kind:
    INVOICE        the value labelled "Invoice No" — no fixed prefix.
    PO             the value that starts "PO".
    INWARD         the value that starts "MIN" (labelled "MIN No"). An INWARD
                   page ALWAYS also prints an invoice number of its own
                   (labelled "DC/Invoice No") — that is a different value,
                   goes in dc_number below, and must never be put in
                   doc_number even though it often sits higher on the page.
    PURCHASE_BILL  the value that starts "PB" (labelled "PV No"). A
                   PURCHASE_BILL page ALWAYS also prints an invoice number of
                   its own (labelled "Invoice No") — that is a different
                   value, goes in dc_number below, and must never be put in
                   doc_number, even though it often sits higher on the page
                   or looks more prominent.
  Before finalising doc_number on an INWARD or PURCHASE_BILL page, check its
  prefix against the table above — if it starts with anything other than
  "MIN" or "PB" respectively, it is the wrong value.
- po_number is a *referenced* order number — always a "PO" value by the rule
  above. "Recipient PO No." is often blank while "Order No." is filled; use
  whichever carries the buyer's order number, preferring "Recipient PO No."
  when both are present.
- dc_number, on an INWARD or PURCHASE_BILL page, is that page's *own* invoice
  reference described above — printed as "DC/Invoice No" (INWARD) or
  "Invoice No" (PURCHASE_BILL) even though there is no actual challan. This is
  a *second, separate* field from doc_number, not an alternate place for the
  same value — an INWARD or PURCHASE_BILL page prints two different numbers
  (its own MIN/PB number, and the invoice number it references) and both get
  recorded, one in doc_number, the other here in dc_number. Finding and
  filling doc_number does not excuse leaving dc_number null: go back and read
  the invoice number specifically for this field even after doc_number is
  already settled. dc_number is never blank on these two page kinds — copy
  it in exactly as you would a real challan number on an INVOICE.
- Tax comes in two shapes. Inter-state: one IGST amount, tax_type is IGST.
  Intra-state: CGST and SGST split roughly evenly, tax_type is CGST_SGST.
  Never report the same tax under both shapes.
- Totals usually reconcile as basic_value + tax + tcs_amount + rounding_off.
  Capture TCS and rounding off even when they are tiny — without them the total
  will not reconcile against the purchase order.
- delivery_address_raw is the "Name & Address of Delivery" block. On a
  construction document this identifies the site, so copy it in full.
- vehicle_number is the truck that carried the delivery — printed as
  "Vehicle No", "Truck No", "Motor Vehicle No", or "Vehicle Number" —
  only present on an INVOICE or an INWARD (MIN Voucher) page. Leave it
  null on every other doc_kind, and null if the field is printed but left
  blank on the form itself.
- Line items: one entry per row of the item table. Invoice line tables often
  carry their own D.C.No and D.C.Date columns — capture them per line.
- description_raw is this line's material or service, transcribed exactly as
  printed and in full — brand, grade, size and spec ("TMT Bars Fe550D CRS
  Bend- 12 MM", "OPC Cement 53 Grade UltraTech") kept on it, not dropped or
  split off. This text is how the same material gets recognised as the same
  material across different documents, so transcribe the wording and order
  actually printed rather than paraphrasing, reordering, expanding an
  abbreviation or abbreviating a spelled-out word — a rewrite that reads the
  same to a person reads as a different material to the system matching
  against every earlier document.
- A numbered reference catalog of this client's known materials may follow
  this prompt, each entry as "id — name (unit)". For every line, check
  whether it is genuinely the same real-world material as one of those
  entries, no matter how differently it's worded on this particular page —
  same reasoning a purchasing clerk would use, not a text match ("OPC" is
  Ordinary Portland Cement, "TMT 12mm" is a TMT Steel Bar 12mm, a brand name
  is still that generic material). If so, put that entry's own id in
  matched_material_id. If you are not genuinely confident, or the catalog
  doesn't contain this material at all, leave matched_material_id null —
  never invent an id that isn't on the list, and never force a match onto
  the closest-sounding entry when it plainly isn't the same material.
- EVERY entry in `lines` must be a row that names a material or a service and
  states how much of it was supplied. A row with no quantity is not a line
  item. This matters because vendors print the tax/total breakup as trailing
  rows of the very same ruled table, right under the real item rows and
  still lined up under the Rate/Amount columns — "Basic Value", "Taxable
  Value", "IGST/CGST/SGST @ N%", "Total Value of Goods / Services", "NET
  Rounded Amount", "Amount in words". Those are the header totals
  (basic_value, igst/cgst/sgst_amount, total_value, rounding_off) wearing a
  table row's shape, and they belong in those header fields only. Read the
  item table's own rows, stop where the quantities stop, and put nothing
  from the totals block into `lines`. A one-item invoice returns exactly one
  line however many ruled rows sit beneath it.
- Ignore terms and conditions, bank details, declarations and signature blocks.

A PURCHASE_BILL page prints three of this client's own reference numbers
together, all three required: doc_number (its own "PV No", starts "PB"),
min_number (the "MIN No" it references, starts "MIN"), and dc_number (the
"Invoice No" it references — no "DC/" prefix on this particular form, unlike
INWARD's "DC/Invoice No" label, but it is the same field). All three are
printed side by side near the top of the page; read all three before moving
to the line items, and if you can only find some of them, still record
whichever are actually printed rather than leaving all null.

If doc_kind is INWARD, each line's quantity is that document's own "MIN
Qty" / "Qty" column — what was offered for receipt. Also read, per line:
  accept_qty  the "Accept Qty" column — what was actually taken in.
  reject_qty  the "Reject Qty" column — what was refused (short delivery,
              damaged, wrong spec). A MIN Voucher / inward note prints both
              columns even when reject_qty is 0 for every line — transcribe
              the printed 0 as 0, not null; null means the column itself
              isn't on the page, not that nothing was rejected.
These two are specific to INWARD lines — leave both null on every other
document type, even if a column happens to look similar.

If a value is genuinely unreadable — blur, glare, a fold across the digits —
return null rather than a guess."""


def _blocks(image_paths: list[str]) -> list[dict]:
    """Every page of the document as base64 content blocks, in order."""
    blocks: list[dict] = []
    for path in image_paths:
        full = BASE_DIR / path
        if not full.exists():
            raise FileNotFoundError(f"page missing from disk: {path}")
        media_type = media.media_type_for(full)
        data = base64.standard_b64encode(full.read_bytes()).decode()
        blocks.append({
            # A PDF page goes in as a document block, an image as an image block.
            "type": "document" if media_type == "application/pdf" else "image",
            "source": {"type": "base64", "media_type": media_type, "data": data},
        })
    return blocks


# A batch upload (several files picked at once) queues one background task
# per document. Starlette's own BackgroundTasks awaits them one at a time —
# see venv/starlette/background.py — but a real, reproduced incident this
# session (3 genuinely different invoices uploaded together; 2 of the 3 came
# back from the vision model carrying the third one's vendor/invoice number,
# byte-for-byte, until each was individually re-extracted and immediately
# came back correct) shows something in this path still lets two engine
# calls overlap in practice. This lock makes that structurally impossible
# regardless of where the overlap actually comes from — at most one call
# into the vision model runs at a time, for both documents and quotations.
# The cost is a batch extracting one-by-one instead of in parallel, which
# for this app's volume is a small price for never mixing up two invoices.
ENGINE_LOCK = threading.Lock()


_NULL_WORDS = {"null", "none", "n/a", "na", "nil", "-"}


def _denull(value):
    """The model is told to return null for a missing field, but sometimes
    writes the word instead of leaving it out — seen for real on dc_number
    and irn. Recurses through dicts/lists so it catches that wherever it
    lands, not just at the top level."""
    if isinstance(value, str):
        return None if value.strip().lower() in _NULL_WORDS else value
    if isinstance(value, dict):
        return {k: _denull(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_denull(v) for v in value]
    return value


def run_engine(
    image_paths: list[str], document_type: str, *, retry_guidance: str = "",
) -> dict:
    """All pages of one document in, structured fields out.

    `document_type` is only the operator's hint; the model classifies the page
    itself and its answer wins. Someone filing a challan as an invoice on the
    phone must not make the extraction wrong.

    retry_guidance is what makes a re-read worth running at all — see
    build_retry_guidance. Without it, re-reading the same image with the same
    prompt is a coin flip: nothing about the second attempt gives it any
    reason to do better than the first.

    Dispatches to whichever provider EXTRACT_PROVIDER names — both share this
    schema and prompt, so switching providers doesn't change what gets stored.
    """
    if not image_paths:
        raise ValueError("a document with no pages cannot be extracted")

    hint = (
        f"The operator filed this as {document_type}, which may be wrong — classify it yourself."
        if document_type and document_type != "UNCLASSIFIED"
        else "Classify this document."
    )
    prompt = (
        f"{hint} Transcribe every field you can read. This is one document,"
        f" {len(image_paths)} page(s), in order."
    )
    prompt += _ocr_cross_check(image_paths)
    prompt += _material_catalog_block()
    prompt += retry_guidance

    # A re-read gets the bigger model and a real thinking budget — see
    # THOROUGH_MODEL. Every rule the routine pass runs under still applies:
    # this is the same SYSTEM prompt, the same material catalogue and the
    # same OCR cross-check, read again by something with more to spend on it.
    thorough = bool(retry_guidance)
    runner = _run_openai if PROVIDER == "openai" else _run_anthropic
    return _denull(runner(image_paths, prompt, thorough=thorough))


# ── guided re-read ───────────────────────────────────────────────────────────
# What separates a re-read from the first read. Two things go into the prompt
# that weren't available the first time round:
#
#   · the specific checks this document currently fails. These are not
#     opinions — a GSTIN's 15th character is a checksum over the first 14,
#     and quantity x rate either equals the printed amount or it doesn't. So
#     "one character in this exact field is wrong" is a far stronger
#     instruction than "read the page again".
#   · whatever a reviewer has already corrected by hand, as settled fact —
#     both so a re-read stops throwing that work away, and because a known-
#     correct PO number or vendor name orients the model on the rest of the
#     page.
#
# The obvious hazard is anchoring: handed its own previous answer and told a
# field fails a check, a model can "fix" the field to satisfy the check
# rather than to match the page — turning a flagged-wrong GSTIN into a
# valid-looking wrong one, which is strictly worse because nothing catches it
# afterwards. The instruction block below is explicit that the image decides
# and a genuinely-failing value stays as printed.

_ARITH_TOLERANCE = 0.01


def _arithmetic_off(a: float, b: float) -> bool:
    return abs(a - b) > max(1.0, max(abs(a), abs(b)) * _ARITH_TOLERANCE)


def _describe_problems(header: dict, lines: list[dict]) -> list[str]:
    """The checks this document currently fails, each phrased as something to
    go and look at. Mirrors what the review screen shows a person, so the
    model is asked about exactly what a reviewer would query."""
    problems: list[str] = []

    for label, key in (("Vendor", "vendor_gstin"), ("Buyer", "buyer_gstin")):
        value = header.get(key)
        if value and gstin_checksum_ok(value) is False:
            problems.append(
                f"{label} GSTIN currently reads \"{value}\" and fails its check digit. A GSTIN's"
                " 15th character is a checksum computed over the first 14, so at least one"
                " character of it is misread. Re-read all 15 characters from the image."
            )

    for line in lines:
        qty, rate, amount = line.get("quantity"), line.get("rate"), line.get("amount")
        if qty is not None and rate is not None and amount is not None and _arithmetic_off(qty * rate, amount):
            problems.append(
                f"On line {line.get('line_no')}, quantity x rate does not equal the amount"
                f" ({qty} x {rate} = {round(qty * rate, 2)}, but the amount was read as {amount})."
                " One of those three numbers is misread — re-read all three."
            )
        if not line.get("material_id"):
            problems.append(
                f"Line {line.get('line_no')}'s description was read as"
                f" \"{line.get('description_raw')}\" and matches no known material — it is likely"
                " garbled. Re-read that line's description."
            )

    parts = [header.get(k) or 0 for k in
             ("basic_value", "igst_amount", "cgst_amount", "sgst_amount", "tcs_amount", "rounding_off")]
    if header.get("basic_value") is not None and header.get("total_value") is not None:
        if _arithmetic_off(sum(float(p) for p in parts), float(header["total_value"])):
            problems.append(
                "The basic value, taxes, TCS and rounding off do not add up to the total value."
                " Re-read the whole totals block."
            )

    for field in REQUIRED_FIELDS_BY_KIND.get(header.get("doc_kind") or "", ()):
        if not str(header.get(field) or "").strip():
            problems.append(
                f"{FIELD_LABELS.get(field, field)} came back empty, but a"
                f" {header.get('doc_kind')} page always prints one. Find it on the page."
            )

    return problems


# Compared against the engine's own original output to find what a person
# changed afterwards. Derived fields (doc_date, vendor_id, qr_verified) and
# anything save_extraction nulls by document kind are left out — a difference
# there is this system's own normalisation, not somebody's correction.
_CONFIRMABLE_FIELDS = {
    "doc_kind": "Document type", "doc_number": "Document no.", "po_number": "PO no.",
    "dc_number": "DC / invoice no.", "min_number": "MIN no.",
    "doc_date_raw": "Document date", "vendor_name_raw": "Vendor name",
    "vendor_gstin": "Vendor GSTIN", "buyer_gstin": "Buyer GSTIN",
    "place_of_supply": "Place of supply", "delivery_address_raw": "Delivery address",
    "vehicle_number": "Vehicle no.", "basic_value": "Basic value", "tax_type": "Tax type",
    "igst_amount": "IGST", "cgst_amount": "CGST", "sgst_amount": "SGST",
    "tcs_amount": "TCS", "rounding_off": "Rounding off", "total_value": "Total value",
    "irn": "IRN",
}


def _describe_confirmed(header: dict, original: dict) -> list[str]:
    """Fields a reviewer has since corrected — a stored value that is both
    non-empty and different from what the engine first said. The non-empty
    half matters: a field the system deliberately blanked (min_number on an
    invoice, say) differs from the original too, and is nobody's correction."""
    confirmed = []
    for field, label in _CONFIRMABLE_FIELDS.items():
        current, first = header.get(field), original.get(field)
        if current in (None, "") or current == first:
            continue
        confirmed.append(f"{label} is \"{current}\"")
    return confirmed


def build_retry_guidance(con: sqlite3.Connection, document_id: str) -> str:
    """The extra prompt section for a re-read, or "" when there's nothing to
    say (a first extraction, or a document with no stored prior read)."""
    row = con.execute(
        "SELECT extracted_json FROM documents WHERE id = ?", (document_id,)
    ).fetchone()
    if row is None or not row["extracted_json"]:
        return ""
    try:
        original = json.loads(row["extracted_json"])
    except (TypeError, ValueError):
        return ""

    header_row = con.execute(
        "SELECT * FROM doc_headers WHERE document_id = ?", (document_id,)
    ).fetchone()
    if header_row is None:
        return ""
    header = dict(header_row)
    lines = [dict(r) for r in con.execute(
        "SELECT line_no, description_raw, material_id, quantity, rate, amount"
        " FROM doc_lines WHERE document_id = ? ORDER BY line_no", (document_id,)
    )]

    problems = _describe_problems(header, lines)
    confirmed = _describe_confirmed(header, original)
    if not problems and not confirmed:
        return ""

    block = (
        "\n\nThis page has been read once already and is being re-read because that read"
        " has problems. Treat the image as the only authority: everything below is"
        " context about the previous attempt, not something to reproduce."
        "\n\nTake your time with this one. Work the page deliberately rather than at a"
        " glance: read the header block field by field, then work down the item table"
        " one row at a time — for each row, read its description, its quantity, its"
        " unit, its rate and its amount separately and check that quantity x rate"
        " actually gives the amount printed beside it. Then read the totals block on"
        " its own, and confirm the item rows you kept are only the rows that name a"
        " material and state a quantity. Every rule you were given above still applies"
        " in full; this is the same job done more carefully, not a different one."
    )
    if problems:
        block += (
            "\n\nThese specific things are provably wrong or missing in the previous read."
            " Re-examine each of these fields on the image, character by character, before"
            " answering:\n- " + "\n- ".join(problems)
        )
        block += (
            "\n\nImportant: correct these by reading the image again, never by adjusting a"
            " value until it satisfies a check. If what is actually printed genuinely fails"
            " its check digit or genuinely does not add up, transcribe what is printed and"
            " leave it failing — a plausible-looking wrong value is far worse than a flagged"
            " one, because nothing downstream catches it."
        )
    if confirmed:
        block += (
            "\n\nA person has since checked this page against these values and corrected them"
            " by hand. Treat them as settled and return them unchanged, and use them to orient"
            " yourself on the rest of the page:\n- " + "\n- ".join(confirmed)
        )
    return block


def _material_catalog_block() -> str:
    """This client's verified materials, offered to the model so it can match
    a line against one of them by what it actually is, not by its own
    wording — see matched_material_id in the Line schema and the SYSTEM rule
    that reads this block. Limited to verified=1 rows: the much larger
    unverified pile is exactly the noisy, near-duplicate output of past
    unmatched lines, and offering that back to the model would teach it to
    match against its own earlier mistakes."""
    with db() as con:
        rows = con.execute(
            "SELECT id, name, unit FROM materials WHERE verified = 1 ORDER BY name"
        ).fetchall()
    if not rows:
        return ""
    catalog = "\n".join(f"{r['id']} — {r['name']} ({r['unit']})" for r in rows)
    return "\n\nReference catalog of known materials:\n" + catalog


def _ocr_cross_check(image_paths: list[str]) -> str:
    """A second, independent read of the same pages via local OCR (see
    ocr.py) — appended to the prompt as extra context the vision model can
    weigh, never as a replacement for its own read of the images. Empty
    string when ENABLE_OCR is off (the default) or every page's OCR pass
    failed, so the prompt is byte-identical to before this existed."""
    if not ocr.ENABLED:
        return ""
    pages = [ocr.read_page(str(BASE_DIR / p)) for p in image_paths]
    parts = [f"--- page {i + 1} ---\n{text}" for i, text in enumerate(pages) if text]
    if not parts:
        return ""
    return (
        "\n\nA local OCR pass also read these pages; its text follows, page by page. Treat it "
        "only as a cross-check on your own reading of the images — the images are the "
        "authoritative source. Where the OCR text disagrees with what you read from the image "
        "itself, prefer whichever one you are more confident is actually correct; do not "
        "blindly prefer the OCR text over the image, it has its own misreads (it has been seen "
        "substituting a wrong character for symbols like ₹).\n\n" + "\n\n".join(parts)
    )


# ── page boundaries ──────────────────────────────────────────────────────────
# One browser upload — a multi-page PDF, or several photos picked together —
# is not always one document: the site may scan an invoice, its MIN Voucher
# and the purchase bill together as one file. This runs once per upload,
# before extraction, so store_batch_pages' flat page list can be split into
# the right number of documents instead of every page landing in one.

class PageInfo(BaseModel):
    document_title: str
    is_new_document: bool


class PageBoundaries(BaseModel):
    pages: list[PageInfo]


SYSTEM_BOUNDARIES = """You look at scanned pages, in order, and decide where one document \
ends and the next begins. This batch may hold several different documents scanned together \
— e.g. a supplier invoice, a MIN Voucher / material inward note, and a purchase bill, filed \
one after another — or it may be a single document that runs across several pages, such as \
an invoice whose item table continues onto a second page.

For every page, first read the title actually printed at the top of that specific page — \
look there before deciding anything. Common titles in this domain: TAX INVOICE, MIN VOUCHER \
/ MATERIAL INWARD NOTE, PURCHASE BILL VOUCHER, PURCHASE ORDER, DELIVERY CHALLAN. Put what you \
read in document_title (or "(continuation)" if the page has no title of its own — just a
table, totals, terms, or a signature block continuing the page before it).

Then set is_new_document: true if this page's title differs from the page immediately before \
it, or this is page 1. false only if this page has no title of its own and is plainly \
continuing the previous page's document. A different title always means a new document, even \
if the vendor, project or PO number printed on it is the same as the page before — the same \
delivery is routinely covered by an invoice, then a separate MIN Voucher, then a separate \
Purchase Bill, each its own document even though every one names the same vendor and PO."""


def classify_page_boundaries(image_paths: list[str]) -> list[bool]:
    """True at every page that starts a new document; page 1 is always True.

    A malformed or wrong-length answer falls back to treating the whole batch
    as one document — the same thing that happened before this existed, and
    safer than guessing at a split that might be wrong.
    """
    if len(image_paths) <= 1:
        return [True] * len(image_paths)

    prompt = (
        f"{len(image_paths)} pages, in order. For each one: what title is printed on it, and"
        " does it start a new document?"
    )

    try:
        with ENGINE_LOCK:
            if PROVIDER == "openai":
                data = _run_openai(image_paths, prompt, system=SYSTEM_BOUNDARIES, output_format=PageBoundaries)
            else:
                data = _run_anthropic(image_paths, prompt, system=SYSTEM_BOUNDARIES, output_format=PageBoundaries)
    except Exception:
        # An upload must still succeed even if the boundary check can't run
        # right now (no credentials, a transient API error) — the same
        # fallback as a malformed answer: keep the batch as one document.
        return [True] + [False] * (len(image_paths) - 1)

    pages = data.get("pages") or []
    if len(pages) != len(image_paths):
        return [True] + [False] * (len(image_paths) - 1)
    return [True] + [bool(p.get("is_new_document")) for p in pages[1:]]


# ── quotations ───────────────────────────────────────────────────────────────
# A vendor's price quotation, not a purchase document — same one-call vision
# read as run_engine, but its own schema and prompt: no doc_kind (the caller
# already knows what this is) and a grade/brand field the invoice schema has
# no use for.

class QuotationLine(BaseModel):
    description_raw: str | None
    # Brand/grade/spec called out separately, e.g. "Fe550D" or "UltraTech OPC
    # 53" — kept out of description_raw so it doesn't corrupt the material
    # alias match every other document type relies on.
    grade_raw: str | None
    hsn_code: str | None
    quantity: float | None
    unit: str | None
    rate: float | None
    amount: float | None
    tax_rate: float | None


class QuotationExtraction(BaseModel):
    vendor_name_raw: str | None
    vendor_gstin: str | None
    quote_number: str | None
    quote_date_raw: str | None
    lines: list[QuotationLine]


SYSTEM_QUOTATION = """You read photographs and scans of a vendor's price quotation for \
construction materials and transcribe them. You are a transcriber, not an analyst — \
this is an offer letter or rate quotation, not a tax invoice, so it may carry no GST \
breakup at all.

Rules:
- Transcribe what is printed. Never infer, calculate or complete a value. If a
  field is not on the page, return null. A wrong value is far worse than null:
  null is visibly missing and gets fixed in review, a wrong value is not.
- Dates: copy the characters exactly as printed into quote_date_raw. Do not
  reformat or reorder them — Indian documents are day-first and the server
  parses them; reordering here corrupts the date silently.
- Amounts: digits only. No currency symbol, no thousands separator. Keep the
  decimals as printed.
- quote_number is this quotation's own reference number, if it has one.
- Line items: one entry per row of the item table. description_raw is the
  material as named on the line. grade_raw is any brand, grade or spec called
  out for that line — "Fe550D", "53 Grade", "UltraTech", "ISI marked" — kept
  separate from description_raw rather than appended to it. Not every line
  carries one; leave it null rather than inventing one.
- rate is the quoted unit price; amount is the line total if the document
  prints one. Do not calculate amount from rate x quantity if it is not
  printed — leave it null.
- Ignore terms and conditions, validity periods, bank details and signature
  blocks.

If a value is genuinely unreadable — blur, glare, a fold across the digits —
return null rather than a guess."""


def run_quotation_engine(image_paths: list[str]) -> dict:
    """All pages of one vendor's quotation in, structured fields out.

    Unlike run_engine there is no document_type hint to pass along — the
    caller already knows this is a quotation, only the model needs telling.
    """
    if not image_paths:
        raise ValueError("a document with no pages cannot be extracted")

    prompt = (
        "Transcribe every field you can read from this vendor quotation."
        f" This is one document, {len(image_paths)} page(s), in order."
    )

    if PROVIDER == "openai":
        return _denull(_run_openai(image_paths, prompt, system=SYSTEM_QUOTATION, output_format=QuotationExtraction))
    return _denull(_run_anthropic(image_paths, prompt, system=SYSTEM_QUOTATION, output_format=QuotationExtraction))


def _run_anthropic(
    image_paths: list[str], prompt: str, *, system: str = SYSTEM, output_format=Extraction,
    thorough: bool = False,
) -> dict:
    if anthropic is None:
        raise EngineNotConfigured(
            "The anthropic package is not installed — pip install -r requirements.txt"
        )
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        raise EngineNotConfigured(
            "No Claude credentials found. Set ANTHROPIC_API_KEY (or run `ant auth login`) "
            "and restart the server."
        )

    client = anthropic.Anthropic()
    # Streamed: a dense multi-page invoice at high effort can outrun the
    # non-streaming HTTP timeout.
    with client.messages.stream(
        model=THOROUGH_MODEL if thorough else MODEL,
        max_tokens=16000,
        system=system,
        # A routine read picks its own budget; a re-read is told to spend.
        thinking=(
            {"type": "enabled", "budget_tokens": THOROUGH_THINKING_TOKENS}
            if thorough else {"type": "adaptive"}
        ),
        messages=[{
            "role": "user",
            "content": [*_blocks(image_paths), {"type": "text", "text": prompt}],
        }],
        output_format=output_format,
    ) as stream:
        response = stream.get_final_message()

    if response.stop_reason == "refusal":
        raise RuntimeError("the model declined to read this document")
    if response.parsed_output is None:
        raise RuntimeError("the model returned no structured output")
    return response.parsed_output.model_dump()


def _image_data_urls(image_paths: list[str]) -> list[dict]:
    """Pages as OpenAI image_url content blocks.

    ponytail: gpt-4o-mini's vision input takes images only, not the native PDF
    blocks Claude reads — add PDF-to-image conversion if a document actually
    needs the openai provider and arrives as a PDF.
    """
    blocks = []
    for path in image_paths:
        full = BASE_DIR / path
        if not full.exists():
            raise FileNotFoundError(f"page missing from disk: {path}")
        media_type = media.media_type_for(full)
        if media_type == "application/pdf":
            # Unreachable for anything uploaded since PDFs started being
            # rendered to pages at intake; rows stored before that still hold a
            # .pdf path, and this says so honestly rather than pointing at a
            # provider the deployment may have no key for.
            raise RuntimeError(
                "this document was stored as a PDF before pages were rendered at upload —"
                " re-run the PDF backfill, or re-upload it"
            )
        data = base64.standard_b64encode(full.read_bytes()).decode()
        blocks.append({
            "type": "image_url",
            "image_url": {"url": f"data:{media_type};base64,{data}"},
        })
    return blocks


def _run_openai(
    image_paths: list[str], prompt: str, *, system: str = SYSTEM, output_format=Extraction,
    thorough: bool = False,
) -> dict:
    if openai is None:
        raise EngineNotConfigured(
            "The openai package is not installed — pip install -r requirements.txt"
        )
    if not os.environ.get("OPENAI_API_KEY"):
        raise EngineNotConfigured(
            "No OpenAI credentials found. Set OPENAI_API_KEY and restart the server."
        )

    client = openai.OpenAI()
    response = client.chat.completions.parse(
        model=THOROUGH_MODEL if thorough else MODEL,
        messages=[
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": [{"type": "text", "text": prompt}, *_image_data_urls(image_paths)],
            },
        ],
        response_format=output_format,
    )
    message = response.choices[0].message
    if message.refusal:
        raise RuntimeError("the model declined to read this document")
    if message.parsed is None:
        raise RuntimeError("the model returned no structured output")
    return message.parsed.model_dump()


# ── persistence ──────────────────────────────────────────────────────────────

_HEADER_FIELDS = (
    "doc_kind", "doc_number", "po_number", "dc_number", "min_number", "doc_date", "doc_date_raw",
    "vendor_id", "vendor_name_raw", "vendor_gstin", "buyer_gstin",
    "place_of_supply", "delivery_address_raw", "vehicle_number",
    "basic_value", "tax_type", "igst_amount", "cgst_amount", "sgst_amount",
    "tcs_amount", "rounding_off", "total_value", "irn", "qr_verified",
)


# ── totals rows that arrive as line items ────────────────────────────────────
# The SYSTEM prompt already tells the model that an invoice's trailing
# "Basic Value / Taxable Value / IGST @ 18% / Total Value / NET Rounded
# Amount" rows are the totals block and not line items. It mostly obeys —
# but a prompt rule is a request, and this one has been broken repeatedly on
# real invoices, each time permanently polluting the materials master with
# an auto-created "material" called IGST @ 18.00 %. Anything the app cannot
# afford to have wrong occasionally needs a check that doesn't depend on the
# model's cooperation, so this is that check.
#
# Both conditions have to hold before a row is dropped: its text has to name
# a value type *and* it has to carry no quantity. A real material line on
# these documents always states how much was supplied, so the pair together
# is very hard to trip accidentally — a genuine material would have to be
# named "Basic Value" and be supplied in no measurable amount.

_TOTALS_LABEL_RE = re.compile(
    r"""^\s*(
          (basic|taxable|total|net|gross|invoice)\s+(value|amount)
        | (sub\s*)?total\s+(value|amount|of\s+goods)
        | grand\s+total
        | net\s+rounded | rounded\s+amount | round(ing)?[\s-]*off
        | amount\s+in\s+words | in\s+words
        | (i|c|s)?gst\s*[@:]
        | (igst|cgst|sgst|gst)\s+@
        | t[cd]s\s*[@:]?\s*\d
        )""",
    re.I | re.X,
)


def is_totals_row(line: dict) -> bool:
    """True for a totals-block row the model returned as if it were an item."""
    text = (line.get("description_raw") or "").strip()
    if not text or not _TOTALS_LABEL_RE.match(text):
        return False
    quantity = line.get("quantity")
    return quantity in (None, "") or float(quantity) == 0


# ── PO-anchored line alignment ───────────────────────────────────────────────
# Matching a line's own text against the whole materials catalogue is what
# free-text matching has to do for a PO — it is the first document in the
# chain and has nothing to anchor to. Every document *after* it does: an
# invoice, MIN Voucher or Purchase Bill quoting a PO number is, line for
# line, that PO's own order. So the question those documents actually pose
# is not "which of 150 catalogue materials is '2 I6B BARS'" (open-ended, and
# it fails exactly when a scan is poor) but "which of this PO's 5 lines is
# it" — a handful of candidates, decided on several independent signals at
# once, and self-correcting: once the confident ones claim their line, an
# unreadable leftover is often the only line still unclaimed.
#
# Measured against the real PO/00538/26-27 set, whose invoice OCR'd as
# "1 MT BARS FISSED CRS BEND- 8 MM" / "2 I6B BARS" / "3 I8MT BARS ...":
# four lines resolve confidently on size+quantity+rate, and "2 I6B BARS" —
# which free-text matching had put on 16mm, inflating that material and
# leaving 10mm looking undelivered — resolves correctly by elimination.

_SIZE_RE = re.compile(r"(\d{1,3})\s*MM\b", re.I)

# A match is applied only at or above this score AND this far clear of the
# runner-up; anything less is left alone for a reviewer rather than guessed.
_ALIGN_MIN_SCORE = 50
_ALIGN_MIN_GAP = 15


def _size_token(text: str | None) -> str | None:
    """The "12 MM" in a description, however mangled the rest of it is — the
    single most discriminating thing on a steel line, and digits survive a
    bad scan far better than words do ("FE550D" came back "FISSED")."""
    match = _SIZE_RE.search(text or "")
    return match.group(1) if match else None


def _within(a, b, tolerance: float) -> bool:
    if a is None or b is None:
        return False
    return abs(a - b) <= tolerance * max(abs(a), abs(b), 1e-9)


def _align_score(line: dict, po_line: dict, index: int, po_index: int) -> int:
    """How much this document line looks like this PO line. Deliberately
    several weak-but-independent signals rather than one strong one: any
    single signal can be destroyed by a bad scan, but a scan that destroys
    the size token, the quantity and the rate at once is not a scan anything
    could have read."""
    score = 0
    size, po_size = _size_token(line.get("description_raw")), _size_token(po_line.get("description_raw"))
    if size and po_size:
        score += 50 if size == po_size else -40
    if _within(line.get("quantity"), po_line.get("quantity"), 0.001):
        score += 30
    elif _within(line.get("quantity"), po_line.get("quantity"), 0.05):
        score += 18
    if _within(line.get("rate"), po_line.get("rate"), 0.001):
        score += 20
    elif _within(line.get("rate"), po_line.get("rate"), 0.05):
        score += 12
    if line.get("hsn_code") and line.get("hsn_code") == po_line.get("hsn_code"):
        score += 15
    if (line.get("unit") or "").upper() == (po_line.get("unit") or "").upper():
        score += 5
    # Documents in this trade list their items in the order they were
    # ordered — worth a nudge, never enough to decide anything on its own.
    if index == po_index:
        score += 8
    return score


def align_lines_to_po(lines: list[dict], po_lines: list[dict]) -> dict[int, str]:
    """{index in `lines` -> material_id from the PO line it matches}.

    Two passes, no DB access — the caller supplies both line lists and
    persists whatever comes back, so this stays independently testable.

    Pass one takes the best-scoring pairs in order, each claiming its PO
    line exclusively, and only where the score clears both thresholds
    against whatever is still unclaimed. Pass two is the elimination case:
    one unresolved line, one unclaimed PO line, nothing else it could be.
    Everything else is left out of the result deliberately — an unresolved
    line keeps whatever the ordinary text match gave it and shows up for a
    reviewer, which is the whole point of not guessing here.
    """
    if not lines or not po_lines:
        return {}

    ranked = sorted(
        ((_align_score(l, p, i, j), i, j) for i, l in enumerate(lines) for j, p in enumerate(po_lines)),
        key=lambda t: -t[0],
    )

    assigned: dict[int, int] = {}
    claimed_lines: set[int] = set()
    claimed_po: set[int] = set()
    for score, i, j in ranked:
        if i in claimed_lines or j in claimed_po:
            continue
        # Re-rank against what's *still* unclaimed: a runner-up that has
        # already been taken by a better-scoring line isn't competition.
        others = sorted(
            (_align_score(lines[i], p, i, k) for k, p in enumerate(po_lines) if k not in claimed_po),
            reverse=True,
        )
        gap = others[0] - others[1] if len(others) > 1 else 10 ** 6
        if score >= _ALIGN_MIN_SCORE and gap >= _ALIGN_MIN_GAP:
            assigned[i] = j
            claimed_lines.add(i)
            claimed_po.add(j)

    leftover_lines = [i for i in range(len(lines)) if i not in claimed_lines]
    leftover_po = [j for j in range(len(po_lines)) if j not in claimed_po]
    if len(leftover_lines) == 1 and len(leftover_po) == 1:
        i, j = leftover_lines[0], leftover_po[0]
        # "Nothing else it can be" is only an argument when nothing actively
        # says otherwise: two legible, *different* sizes are two different
        # materials, however alone they've each been left. Without this, a
        # one-line document against a one-line PO would pair them no matter
        # how plainly they disagree.
        size, po_size = _size_token(lines[i].get("description_raw")), _size_token(po_lines[j].get("description_raw"))
        if not (size and po_size and size != po_size):
            assigned[i] = j

    return {
        i: po_lines[j]["material_id"]
        for i, j in assigned.items()
        if po_lines[j].get("material_id")
    }


# Only these ever quote a PO number and bill against its lines. A PO has
# nothing upstream to anchor to, and a QUOTATION predates the order itself.
_PO_ANCHORED_KINDS = ("INVOICE", "INWARD", "PURCHASE_BILL", "DELIVERY")


def _apply_po_alignment(con: sqlite3.Connection, document_id: str, doc_kind: str, po_number: str | None) -> None:
    """Re-point this document's lines at the materials its own PO uses, where
    align_lines_to_po is confident. Silent by design (see the SYSTEM prompt's
    own "a wrong value is worse than null" rule for the opposite case — here
    the alternative to a confident match is a *known-wrong* material, not a
    null). A line it can't place keeps the ordinary text match and its
    disagreement stays visible in the delivery's own Issues list."""
    if doc_kind not in _PO_ANCHORED_KINDS or not po_number:
        return

    po_row = con.execute(
        "SELECT d.id FROM documents d JOIN doc_headers h ON h.document_id = d.id"
        " WHERE d.document_type = 'PO' AND h.doc_number = ?"
        "   AND d.project_id = (SELECT project_id FROM documents WHERE id = ?)"
        " ORDER BY d.uploaded_at LIMIT 1",
        (po_number, document_id),
    ).fetchone()
    if po_row is None:
        return

    def rows_of(doc_id: str) -> list[dict]:
        return [dict(r) for r in con.execute(
            "SELECT id, line_no, description_raw, material_id, hsn_code, quantity, unit, rate"
            " FROM doc_lines WHERE document_id = ? ORDER BY line_no",
            (doc_id,),
        )]

    lines, po_lines = rows_of(document_id), rows_of(po_row["id"])
    for index, material_id in align_lines_to_po(lines, po_lines).items():
        if lines[index]["material_id"] != material_id:
            con.execute(
                "UPDATE doc_lines SET material_id = ? WHERE id = ?",
                (material_id, lines[index]["id"]),
            )


def save_extraction(con: sqlite3.Connection, document_id: str, data: dict) -> None:
    """Persist engine output into doc_headers + doc_lines, mapping as it goes."""
    gstin = find_gstin(data.get("vendor_gstin"))
    vendor_id = match_vendor(con, data.get("vendor_name_raw"), data.get("vendor_gstin"))

    header = {field: data.get(field) for field in _HEADER_FIELDS}
    header["doc_date"] = parse_date(data.get("doc_date_raw"))
    header["vendor_id"] = vendor_id
    header["vendor_gstin"] = gstin
    header["buyer_gstin"] = find_gstin(data.get("buyer_gstin"))
    header["qr_verified"] = 1 if data.get("qr_verified") else 0
    # Meaningless outside a PURCHASE_BILL — belt-and-braces against a stray
    # value landing on an INVOICE/PO/etc. row just because the model filled
    # the key in anyway.
    if header["doc_kind"] != "PURCHASE_BILL":
        header["min_number"] = None
    # Only an INVOICE or INWARD page has a vehicle attached to it.
    if header["doc_kind"] not in ("INVOICE", "INWARD"):
        header["vehicle_number"] = None

    columns = ", ".join(("document_id", *_HEADER_FIELDS))
    placeholders = ", ".join(["?"] * (len(_HEADER_FIELDS) + 1))
    con.execute(f"DELETE FROM doc_headers WHERE document_id = ?", (document_id,))
    con.execute(
        f"INSERT INTO doc_headers ({columns}) VALUES ({placeholders})",
        (document_id, *(header[field] for field in _HEADER_FIELDS)),
    )

    # Meaningless outside an INWARD line — same belt-and-braces as
    # min_number above, against a stray value landing on an INVOICE/PO/etc.
    # line just because the model filled the key in anyway.
    is_inward = header["doc_kind"] == "INWARD"

    # Dropped before anything is stored, so a totals row never reaches the
    # line table, the materials master, or the three-way match — see
    # is_totals_row. data (and so extracted_json) keeps the model's own
    # unedited answer either way, which is what makes this auditable.
    kept_lines = [l for l in (data.get("lines") or []) if not is_totals_row(l)]

    con.execute("DELETE FROM doc_lines WHERE document_id = ?", (document_id,))
    for index, line in enumerate(kept_lines, start=1):
        description = line.get("description_raw") or ""
        con.execute(
            "INSERT INTO doc_lines (document_id, line_no, description_raw, material_id,"
            " hsn_code, quantity, accept_qty, reject_qty, unit, rate, amount, tax_rate,"
            " dc_number, dc_date)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                document_id, index, description,
                match_material(con, description, line.get("unit"), line.get("matched_material_id")),
                line.get("hsn_code"), line.get("quantity"),
                line.get("accept_qty") if is_inward else None,
                line.get("reject_qty") if is_inward else None,
                line.get("unit"),
                line.get("rate"), line.get("amount"), line.get("tax_rate"),
                line.get("dc_number"), parse_date(line.get("dc_date_raw")),
            ),
        )

    # Now that the lines exist, re-point whichever of them this document's own
    # PO can identify better than their own text could — see align_lines_to_po.
    _apply_po_alignment(con, document_id, header["doc_kind"], header["po_number"])

    duplicate = find_duplicate(con, vendor_id, header["doc_number"], document_id)
    # The classifier's answer is what files the document. An unrecognised kind
    # leaves it UNCLASSIFIED rather than writing a value the CHECK would reject.
    doc_kind = data.get("doc_kind")
    document_type = doc_kind if doc_kind in DOC_TYPES else "UNCLASSIFIED"
    con.execute(
        "UPDATE documents SET status = 'EXTRACTED', document_type = ?, extracted_json = ?,"
        " duplicate_of = ?, error = NULL WHERE id = ?",
        (document_type, json.dumps(data), duplicate, document_id),
    )


def process(document_id: str) -> None:
    """Background task: PENDING -> PROCESSING -> EXTRACTED, or FAILED with a reason.

    The PROCESSING flip is conditioned in the UPDATE's WHERE clause, not just
    checked beforehand: this is the one place every extraction (initial or a
    manual re-extract) actually runs, so it is where a decision made between
    the request and this task running must be protected — a document that is
    already APPROVED/REJECTED must not be silently kicked back into the
    extraction pipeline.
    """
    with db() as con:
        row = con.execute(
            "SELECT file_paths, document_type FROM documents WHERE id = ?", (document_id,)
        ).fetchone()
        if row is None:
            return
        cur = con.execute(
            "UPDATE documents SET status = 'PROCESSING'"
            " WHERE id = ? AND status NOT IN ('APPROVED', 'REJECTED')",
            (document_id,),
        )
        if cur.rowcount == 0:
            return
        paths = json.loads(row["file_paths"])
        document_type = row["document_type"]
        # Empty on a first extraction (nothing has been read yet), so this is
        # what makes a *re*-read different from the read before it rather
        # than the same coin flipped twice — see build_retry_guidance.
        guidance = build_retry_guidance(con, document_id)

    _log_extraction_attempt(document_id, paths, "start" + (" (guided re-read)" if guidance else ""))
    try:
        with ENGINE_LOCK:
            data = run_engine(paths, document_type, retry_guidance=guidance)
    except Exception as exc:
        _log_extraction_attempt(document_id, paths, f"error: {exc}")
        with db() as con:
            con.execute(
                "UPDATE documents SET status = 'FAILED', error = ? WHERE id = ?",
                (str(exc)[:500], document_id),
            )
        return
    _log_extraction_attempt(document_id, paths, f"done: doc_kind={data.get('doc_kind')} doc_number={data.get('doc_number')!r}")

    with db() as con:
        save_extraction(con, document_id, data)


# ── same-batch cross-check ───────────────────────────────────────────────────
# A MIN Voucher and a Purchase Bill both print the invoice number they refer
# to as their own dc_number, and a Purchase Bill also prints the MIN number
# it closed from as its own min_number — by design these are meant to be
# identical to the document they're naming (see the SYSTEM prompt's own
# doc_number/dc_number/min_number rules). When two sibling documents, scanned
# and uploaded together in the same batch, agree on one of these values and a
# third disagrees only by what looks like a character-level misread, that
# third document's own read is almost certainly the wrong one — corrected
# here, before a reviewer ever opens it.

_REF_FIELD_LABELS = {
    "doc_number": "Document no.", "dc_number": "DC / invoice no.",
    "min_number": "MIN no.", "po_number": "PO no.",
}

# Which field, on a document of this doc_kind, carries this reference — e.g.
# every document's own claim of "the invoice number" is an INVOICE's own
# doc_number, or an INWARD/PURCHASE_BILL's dc_number naming it instead.
_REF_GROUPS = {
    "invoice": {"INVOICE": "doc_number", "INWARD": "dc_number", "PURCHASE_BILL": "dc_number"},
    "min": {"INWARD": "doc_number", "PURCHASE_BILL": "min_number"},
    "po": {"PO": "doc_number", "INVOICE": "po_number", "DELIVERY": "po_number",
           "INWARD": "po_number", "PURCHASE_BILL": "po_number"},
}


def _edit_distance(a: str, b: str) -> int:
    """Levenshtein distance. A transposed pair of digits costs 2 here (two
    substitutions) — the tolerance in _plausible_misread is sized for that."""
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            cur[j] = min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (ca != cb))
        prev = cur
    return prev[len(b)]


def _plausible_misread(a: str, b: str) -> bool:
    """Same length, and close enough that one is almost certainly a
    character-level misread of the other — a transposed or substituted
    digit or two, not two numbers that just happen to look similar."""
    if not a or not b or len(a) != len(b) or len(a) < 4:
        return False
    return _edit_distance(a, b) <= max(2, round(len(a) * 0.4))


def reconcile_batch(document_ids: list[str]) -> None:
    """Runs once, after every document from one upload has finished
    extracting (see main.py's _extract_all) — cross-checks the reference
    numbers that are supposed to agree across documents scanned together as
    one delivery, and corrects a lone misread against the other two's
    agreement.

    Never touches a field with fewer than three documents actually carrying
    a value for it: two documents disagreeing is a genuine mismatch with no
    way to tell which one is right, not something to guess at — that stays
    visible as the Delivery info tab's own mismatch banner instead. Same
    reasoning if more than one document disagrees with the rest: a single
    confident outlier gets corrected, a real three-way split does not.
    """
    # Line alignment first, and again here rather than only in
    # save_extraction: that call happens while one document is being saved,
    # so it can only see POs that already existed at that moment. Re-running
    # it once the whole batch has settled makes it order-independent — a PO
    # uploaded in the same batch as its own invoice now anchors that invoice
    # either way round. Cheap and idempotent: a line already pointing at the
    # right material is left exactly as it is.
    with db() as con:
        for row in con.execute(
            "SELECT h.document_id, d.document_type AS doc_kind, h.po_number"
            " FROM doc_headers h JOIN documents d ON d.id = h.document_id"
            f" WHERE h.document_id IN ({','.join('?' * len(document_ids))})"
            " AND d.status = 'EXTRACTED'",
            document_ids,
        ).fetchall():
            _apply_po_alignment(con, row["document_id"], row["doc_kind"], row["po_number"])

    if len(document_ids) < 3:
        return
    with db() as con:
        placeholders = ",".join("?" * len(document_ids))
        rows = con.execute(
            f"SELECT h.document_id, d.document_type AS doc_kind, h.doc_number,"
            f" h.po_number, h.dc_number, h.min_number FROM doc_headers h"
            f" JOIN documents d ON d.id = h.document_id"
            f" WHERE h.document_id IN ({placeholders}) AND d.status = 'EXTRACTED'",
            document_ids,
        ).fetchall()
        docs = {r["document_id"]: dict(r) for r in rows}

        corrections: dict[str, list[str]] = {}
        for field_by_kind in _REF_GROUPS.values():
            entries = []
            for doc_id, doc in docs.items():
                field = field_by_kind.get(doc["doc_kind"])
                value = doc.get(field) if field else None
                if value and str(value).strip():
                    entries.append((doc_id, field, str(value).strip()))
            if len(entries) < 3:
                continue

            counts: dict[str, int] = {}
            for _, _, value in entries:
                counts[value] = counts.get(value, 0) + 1
            majority_value, majority_count = max(counts.items(), key=lambda kv: kv[1])
            if majority_count < 2 or majority_count == len(entries):
                continue  # no majority, or every document already agrees

            outliers = [e for e in entries if e[2] != majority_value]
            if len(outliers) != 1:
                continue  # more than one disagreement — not a confident single misread
            doc_id, field, old_value = outliers[0]
            if not _plausible_misread(old_value, majority_value):
                continue

            con.execute(f"UPDATE doc_headers SET {field} = ? WHERE document_id = ?", (majority_value, doc_id))
            label = _REF_FIELD_LABELS.get(field, field)
            note = (
                f"{label} corrected from a likely misread ‘{old_value}’ to"
                f" ‘{majority_value}’ — matches the other document(s) uploaded with it."
            )
            corrections.setdefault(doc_id, []).append(note)

        for doc_id, notes in corrections.items():
            con.execute(
                "UPDATE doc_headers SET correction_note = ? WHERE document_id = ?",
                ("; ".join(notes), doc_id),
            )


_DEBUG_LOG = BASE_DIR / "extraction_debug.log"


def _log_extraction_attempt(document_id: str, paths: list[str], note: str) -> None:
    """Temporary diagnostic trail for a real, reproduced-but-not-yet-explained
    incident: a document occasionally comes back with another document's
    field values, or fabricated ones, even on a single-page call with no
    other document involved. Records enough to tell apart three distinct
    explanations after the fact — genuinely overlapping calls (timestamps
    would overlap), the wrong bytes being read for a path (hash would show
    it), or the model itself producing a bad answer for the right input
    (everything here checks out and the fault is upstream). Safe to remove
    once the cause is confirmed."""
    try:
        parts = []
        for p in paths:
            full = BASE_DIR / p
            if full.exists():
                digest = hashlib.sha256(full.read_bytes()).hexdigest()[:12]
                parts.append(f"{p}(sha256:{digest},{full.stat().st_size}b)")
            else:
                parts.append(f"{p}(MISSING)")
        line = (
            f"{datetime.now(timezone.utc).isoformat()} thread={threading.get_ident()} "
            f"doc={document_id} {note} pages=[{', '.join(parts)}]\n"
        )
        with open(_DEBUG_LOG, "a", encoding="utf-8") as fh:
            fh.write(line)
    except Exception:
        pass  # diagnostics must never break extraction itself


_QUOTATION_HEADER_FIELDS = (
    "vendor_id", "vendor_name_raw", "vendor_gstin", "quote_number", "quote_date", "quote_date_raw",
)


def save_quotation_extraction(con: sqlite3.Connection, quotation_id: str, data: dict) -> None:
    """Persist engine output into quotations + quotation_lines, mapping as it
    goes — same shape as save_extraction, minus everything that only makes
    sense for a purchase document (doc_kind, tax breakup, duplicate check)."""
    vendor_id = match_vendor(con, data.get("vendor_name_raw"), data.get("vendor_gstin"))

    header = {
        "vendor_id": vendor_id,
        "vendor_name_raw": data.get("vendor_name_raw"),
        "vendor_gstin": find_gstin(data.get("vendor_gstin")),
        "quote_number": data.get("quote_number"),
        "quote_date": parse_date(data.get("quote_date_raw")),
        "quote_date_raw": data.get("quote_date_raw"),
    }
    assignments = ", ".join(f"{field} = ?" for field in _QUOTATION_HEADER_FIELDS)
    con.execute(
        f"UPDATE quotations SET {assignments} WHERE id = ?",
        (*(header[field] for field in _QUOTATION_HEADER_FIELDS), quotation_id),
    )

    con.execute("DELETE FROM quotation_lines WHERE quotation_id = ?", (quotation_id,))
    for index, line in enumerate(data.get("lines") or [], start=1):
        description = line.get("description_raw") or ""
        con.execute(
            "INSERT INTO quotation_lines (quotation_id, line_no, description_raw, material_id,"
            " grade_raw, hsn_code, quantity, unit, rate, amount, tax_rate)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                quotation_id, index, description,
                match_material(con, description, line.get("unit")),
                line.get("grade_raw"), line.get("hsn_code"), line.get("quantity"), line.get("unit"),
                line.get("rate"), line.get("amount"), line.get("tax_rate"),
            ),
        )

    con.execute("UPDATE quotations SET status = 'EXTRACTED', error = NULL WHERE id = ?", (quotation_id,))


def process_quotation(quotation_id: str) -> None:
    """Background task: PENDING -> PROCESSING -> EXTRACTED, or FAILED with a
    reason. Mirrors process() — see there for why the PROCESSING flip is
    conditioned in the UPDATE's WHERE clause rather than checked beforehand."""
    with db() as con:
        row = con.execute(
            "SELECT file_paths FROM quotations WHERE id = ?", (quotation_id,)
        ).fetchone()
        if row is None:
            return
        cur = con.execute(
            "UPDATE quotations SET status = 'PROCESSING' WHERE id = ? AND status = 'PENDING'",
            (quotation_id,),
        )
        if cur.rowcount == 0:
            return
        paths = json.loads(row["file_paths"])

    try:
        with ENGINE_LOCK:
            data = run_quotation_engine(paths)
    except Exception as exc:
        with db() as con:
            con.execute(
                "UPDATE quotations SET status = 'FAILED', error = ? WHERE id = ?",
                (str(exc)[:500], quotation_id),
            )
        return

    with db() as con:
        save_quotation_extraction(con, quotation_id, data)


# ── review: edit, approve, reject ───────────────────────────────────────────
# Approve/reject here is an accuracy gate on the OCR read — "did this transcribe
# correctly" — not a business validation verdict. The 3-way match against a PO
# and delivery challan is a separate, later capability. See Deviation.md §1.

EDITABLE_HEADER_FIELDS = (
    "doc_kind", "doc_number", "po_number", "dc_number", "min_number", "doc_date_raw",
    "vendor_name_raw", "vendor_gstin", "buyer_gstin",
    "place_of_supply", "delivery_address_raw", "vehicle_number",
    "basic_value", "tax_type", "igst_amount", "cgst_amount", "sgst_amount",
    "tcs_amount", "rounding_off", "total_value", "irn",
)

EDITABLE_LINE_FIELDS = (
    "description_raw", "material_id", "hsn_code",
    "quantity", "accept_qty", "reject_qty", "unit", "rate", "amount", "tax_rate",
    "dc_number", "dc_date",
)


def apply_edits(con: sqlite3.Connection, document_id: str, header: dict, lines: list[dict]) -> None:
    """Persist reviewer corrections to already-extracted fields, before a decision."""
    edits = {f: header[f] for f in header if f in EDITABLE_HEADER_FIELDS}
    if "doc_date_raw" in edits:
        con.execute(
            "UPDATE doc_headers SET doc_date_raw = ?, doc_date = ? WHERE document_id = ?",
            (edits.pop("doc_date_raw"), parse_date(header["doc_date_raw"]), document_id),
        )
    if edits:
        assignments = ", ".join(f"{field} = ?" for field in edits)
        con.execute(
            f"UPDATE doc_headers SET {assignments} WHERE document_id = ?",
            (*edits.values(), document_id),
        )
    if header.get("doc_kind") in DOC_TYPES:
        con.execute(
            "UPDATE documents SET document_type = ? WHERE id = ?",
            (header["doc_kind"], document_id),
        )

    for line in lines:
        line_no = line.get("line_no")
        if not line_no:
            raise ValueError("each line edit needs line_no")
        line_edits = {f: line[f] for f in line if f in EDITABLE_LINE_FIELDS}
        if not line_edits:
            continue
        if line_edits.get("material_id") and line.get("description_raw"):
            learn_material_alias(con, line["description_raw"], line_edits["material_id"])
        assignments = ", ".join(f"{field} = ?" for field in line_edits)
        con.execute(
            f"UPDATE doc_lines SET {assignments} WHERE document_id = ? AND line_no = ?",
            (*line_edits.values(), document_id, line_no),
        )


def claim_for_edit(con: sqlite3.Connection, document_id: str) -> bool:
    """Atomically confirms the document is still EXTRACTED, or already
    APPROVED, right before applying reviewer edits — a value-preserving
    UPDATE used purely to take SQLite's write lock conditionally, so an edit
    can't land on a document a concurrent request just rejected (or just
    approved, for the EXTRACTED case).

    APPROVED is allowed back in here for the one flow that needs it — a
    reviewer reopening an already-approved document to fix a value noticed
    later (see the pencil-edit toggle in ReviewModal). It stays APPROVED
    (this doesn't move it back to EXTRACTED); update_document records who
    made the change. REJECTED is not included: that flow has no equivalent
    reopen-and-fix path."""
    cur = con.execute(
        "UPDATE documents SET status = status"
        " WHERE id = ? AND status IN ('EXTRACTED', 'APPROVED')",
        (document_id,),
    )
    return cur.rowcount > 0


# ── quotations: edit ─────────────────────────────────────────────────────────
# No approve/reject to protect against here — a quotation has no decision to
# preserve, only a re-extraction in flight, which claim_quotation_for_edit
# guards against the same way claim_for_edit does above.

EDITABLE_QUOTATION_HEADER_FIELDS = (
    "vendor_name_raw", "vendor_gstin", "quote_number", "quote_date_raw",
)

EDITABLE_QUOTATION_LINE_FIELDS = (
    "description_raw", "material_id", "grade_raw", "hsn_code",
    "quantity", "unit", "rate", "amount", "tax_rate",
)


def apply_quotation_edits(
    con: sqlite3.Connection, quotation_id: str, header: dict, lines: list[dict]
) -> None:
    """Persist reviewer corrections to an already-extracted quotation."""
    edits = {f: header[f] for f in header if f in EDITABLE_QUOTATION_HEADER_FIELDS}
    if "quote_date_raw" in edits:
        con.execute(
            "UPDATE quotations SET quote_date_raw = ?, quote_date = ? WHERE id = ?",
            (edits.pop("quote_date_raw"), parse_date(header["quote_date_raw"]), quotation_id),
        )
    if edits:
        assignments = ", ".join(f"{field} = ?" for field in edits)
        con.execute(
            f"UPDATE quotations SET {assignments} WHERE id = ?",
            (*edits.values(), quotation_id),
        )

    for line in lines:
        line_no = line.get("line_no")
        if not line_no:
            raise ValueError("each line edit needs line_no")
        line_edits = {f: line[f] for f in line if f in EDITABLE_QUOTATION_LINE_FIELDS}
        if not line_edits:
            continue
        if line_edits.get("material_id") and line.get("description_raw"):
            learn_material_alias(con, line["description_raw"], line_edits["material_id"])
        assignments = ", ".join(f"{field} = ?" for field in line_edits)
        con.execute(
            f"UPDATE quotation_lines SET {assignments} WHERE quotation_id = ? AND line_no = ?",
            (*line_edits.values(), quotation_id, line_no),
        )


def claim_quotation_for_edit(con: sqlite3.Connection, quotation_id: str) -> bool:
    """Atomically confirms the quotation is still EXTRACTED right before
    applying edits — guards against a concurrent retry re-running extraction
    (which deletes and rewrites quotation_lines) out from under an edit."""
    cur = con.execute(
        "UPDATE quotations SET status = 'EXTRACTED' WHERE id = ? AND status = 'EXTRACTED'",
        (quotation_id,),
    )
    return cur.rowcount > 0


# Which header fields a document can never be approved without, by its own
# kind — each one is a reference this client's own three-way match (see
# po_reconciliation) depends on to thread documents together:
#   PO             its own number — nothing references a PO that has none.
#   INVOICE/DELIVERY  the PO it was delivered against.
#   INWARD (MIN)   the PO, its own MIN No (doc_number), and the invoice it
#                  received against (dc_number).
#   PURCHASE_BILL  the PO, its own PV/PB No (doc_number), the invoice
#                  (dc_number), and the MIN it was closed from (min_number).
# QUOTATION is exempt — it predates a PO existing at all. Single source of
# truth for both mark_approved's SQL gate below and main.py's error message
# — FE/src/features/review/ReviewModal.jsx mirrors this same table for the
# Approve button's own disabled state, kept in sync by hand.
REQUIRED_FIELDS_BY_KIND = {
    "PO": ("doc_number",),
    "INVOICE": ("po_number",),
    "DELIVERY": ("po_number",),
    "INWARD": ("po_number", "doc_number", "dc_number"),
    "PURCHASE_BILL": ("po_number", "doc_number", "dc_number", "min_number"),
}

FIELD_LABELS = {
    "po_number": "PO no.", "doc_number": "Document no.",
    "dc_number": "DC / invoice no.", "min_number": "MIN no.",
}


def mark_approved(con: sqlite3.Connection, document_id: str, approved_by: str) -> bool:
    """EXTRACTED -> APPROVED, atomically. False (no write at all) if the
    document was not EXTRACTED — already decided, not yet extracted, sitting
    at UNCLASSIFIED because the classifier couldn't tell, or sitting at
    OTHER. Neither is a real business document type here — a reviewer has
    to actively pick one of the real kinds (or reject it, if none of those
    genuinely fit — an RA bill, say) before it can be filed as approved.
    Approval is the one place that has to matter, since it's what files the
    document.

    Beyond that, each kind needs its own required references filled in —
    see REQUIRED_FIELDS_BY_KIND above."""
    per_kind = " OR ".join(
        "(documents.document_type = '{}' AND {})".format(
            kind,
            " AND ".join(f"h.{f} IS NOT NULL AND TRIM(h.{f}) != ''" for f in fields),
        )
        for kind, fields in REQUIRED_FIELDS_BY_KIND.items()
    )
    kinds_list = ", ".join(f"'{k}'" for k in REQUIRED_FIELDS_BY_KIND)
    cur = con.execute(
        "UPDATE documents SET status = 'APPROVED'"
        " WHERE id = ? AND status = 'EXTRACTED' AND document_type NOT IN ('UNCLASSIFIED', 'OTHER')"
        f" AND (document_type NOT IN ({kinds_list}) OR EXISTS ("
        f"   SELECT 1 FROM doc_headers h WHERE h.document_id = documents.id AND ({per_kind})"
        " ))",
        (document_id,),
    )
    if cur.rowcount == 0:
        return False
    con.execute(
        "UPDATE doc_headers SET reviewed_by = ?, reviewed_at = ? WHERE document_id = ?",
        (approved_by, datetime.now(timezone.utc).isoformat(timespec="seconds"), document_id),
    )
    return True


def mark_rejected(con: sqlite3.Connection, document_id: str, rejected_by: str, reason: str) -> bool:
    """EXTRACTED -> REJECTED, atomically. False (no write at all) if the
    document was not EXTRACTED — already decided, or not yet extracted."""
    cur = con.execute(
        "UPDATE documents SET status = 'REJECTED' WHERE id = ? AND status = 'EXTRACTED'",
        (document_id,),
    )
    if cur.rowcount == 0:
        return False
    con.execute(
        "UPDATE doc_headers SET reviewed_by = ?, reviewed_at = ?, rejection_reason = ?"
        " WHERE document_id = ?",
        (rejected_by, datetime.now(timezone.utc).isoformat(timespec="seconds"), reason, document_id),
    )
    return True


# ── self-check ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import db as _db

    # Dates: every shape the three samples actually print, plus the ambiguous one.
    assert parse_date("08.08.2023") == "2023-08-08"
    assert parse_date("05-Mar-2020") == "2020-03-05"
    assert parse_date("08/08/2023") == "2023-08-08"
    assert parse_date("2023-08-08") == "2023-08-08"
    assert parse_date("08-08-23") == "2023-08-08"
    assert parse_date("5 March 2020") == "2020-03-05"
    # The one that matters: day-first, never month-first.
    assert parse_date("05/03/2026") == "2026-03-05", "must read 5 March, not 3 May"
    assert parse_date("") is None
    assert parse_date("not a date") is None
    assert parse_date(None) is None

    # GSTINs taken off the sample documents. These two are the valid shape.
    assert find_gstin("Recipient GSTIN/UIN No.:07AABCN7057J1Z8") == "07AABCN7057J1Z8"
    assert find_gstin("GSTIN 24AAACC1206D1ZG") == "24AAACC1206D1ZG"
    assert is_valid_gstin("07AABCN7057J1Z8")
    # The template sample prints a made-up one. The loose pattern still catches
    # it so the reviewer sees something, but it is not treated as trustworthy.
    assert find_gstin("GSTIN : 24HDE7487RE5RT4") == "24HDE7487RE5RT4"
    assert not is_valid_gstin("24HDE7487RE5RT4")
    assert find_gstin("no identifier here") is None

    assert normalise("  OPC   Cement 53 Grade. ") == "opc cement 53 grade"

    # compare_document_lines: two documents believed to be the same delivery
    # billed twice (site copy, office copy) — pure function, no DB needed.
    _site = [
        {"material_id": "MAT-STEEL", "material_name": "TMT Steel Bar 12mm", "quantity": 50, "rate": 62000},
        {"material_id": "MAT-CEMENT", "material_name": "OPC Cement 53", "quantity": 100, "rate": 380},
    ]
    _office_mismatched = [
        {"material_id": "MAT-STEEL", "material_name": "TMT Steel Bar 12mm", "quantity": 45, "rate": 62000},
        {"material_id": "MAT-CEMENT", "material_name": "OPC Cement 53", "quantity": 100, "rate": 380},
    ]
    _diff = compare_document_lines(_site, _office_mismatched)
    assert _diff["clean"] is False
    _steel = next(l for l in _diff["lines"] if l["material_id"] == "MAT-STEEL")
    _cement = next(l for l in _diff["lines"] if l["material_id"] == "MAT-CEMENT")
    assert _steel["match"] is False and _steel["qty_a"] == 50 and _steel["qty_b"] == 45
    assert _cement["match"] is True

    _diff_clean = compare_document_lines(_site, [dict(l) for l in _site])
    assert _diff_clean["clean"] is True and all(l["match"] for l in _diff_clean["lines"])

    # A material present on only one side is a mismatch, not silently skipped.
    _diff_missing = compare_document_lines(_site, [_site[0]])
    _cement_missing = next(l for l in _diff_missing["lines"] if l["material_id"] == "MAT-CEMENT")
    assert _cement_missing["match"] is False and _cement_missing["qty_b"] is None
    assert _diff_missing["clean"] is False

    # Same material split across two rows on one side must still compare
    # clean against one consolidated row on the other — sum, not first-wins.
    _site_split = [
        {"material_id": "MAT-STEEL", "material_name": "TMT Steel Bar 12mm", "quantity": 20, "rate": 62000},
        {"material_id": "MAT-STEEL", "material_name": "TMT Steel Bar 12mm", "quantity": 30, "rate": 62000},
    ]
    _office_single = [{"material_id": "MAT-STEEL", "material_name": "TMT Steel Bar 12mm", "quantity": 50, "rate": 62000}]
    assert compare_document_lines(_site_split, _office_single)["clean"] is True

    _db.init()
    with _db.db() as con:
        seeded = match_material(con, "OPC 53")
        assert seeded == "MAT-OPC-CEMENT-53-GRADE", seeded
        # Spec sub-lines: the whole block misses, the first line hits.
        assert match_material(con, "Ready Mix Concrete M30\n20mm aggregate\nslump 100") \
            == "MAT-READY-MIX-CONCRETE-M30"
        # Unknown material is created rather than blocking.
        invented = match_material(con, "Zircon Fibre Mesh 400gsm")
        assert invented and invented.startswith("MAT-")
        assert con.execute(
            "SELECT verified FROM materials WHERE id = ?", (invented,)
        ).fetchone()["verified"] == 0
        # And it is remembered.
        assert match_material(con, "Zircon Fibre Mesh 400gsm") == invented

        # A newly created material takes the line's own unit when there is one...
        with_unit = match_material(con, "Galvanised Roofing Sheet 0.5mm", "Sheets")
        assert con.execute(
            "SELECT unit FROM materials WHERE id = ?", (with_unit,)
        ).fetchone()["unit"] == "Sheets"
        # ...and only falls back to "Nos" when the line carries no unit at all.
        no_unit = match_material(con, "Unlabelled Fitting")
        assert con.execute(
            "SELECT unit FROM materials WHERE id = ?", (no_unit,)
        ).fetchone()["unit"] == "Nos"

        # A human correction re-points the alias.
        learn_material_alias(con, "Zircon Fibre Mesh 400gsm", "MAT-WALL-PUTTY")
        assert match_material(con, "Zircon Fibre Mesh 400gsm") == "MAT-WALL-PUTTY"

        # Vendors: GSTIN wins, and a repeat lookup does not duplicate the row.
        first = match_vendor(con, "UltraTech Cement Limited", "09AAACL6442L1Z8")
        again = match_vendor(con, "ULTRATECH CEMENT LTD", "09AAACL6442L1Z8")
        assert first == again, "same GSTIN must resolve to one vendor"
        assert match_vendor(con, None, None) is None

        con.execute(
            "DELETE FROM material_aliases WHERE alias IN (?, ?, ?)",
            ("zircon fibre mesh 400gsm", "galvanised roofing sheet 0.5mm", "unlabelled fitting"),
        )
        con.execute("DELETE FROM materials WHERE verified = 0")
        con.execute("DELETE FROM vendors WHERE id = ?", (first,))

        # apply_edits / mark_approved / mark_rejected against a synthetic document.
        _doc_id, _prj_id = "DOC-selfcheck", "PRJ-selfcheck"
        con.execute(
            "INSERT INTO projects (id, code, name) VALUES (?, 'SELFCHECK', 'Self-check project')",
            (_prj_id,),
        )
        con.execute(
            "INSERT INTO documents (id, project_id, source, document_type, file_paths,"
            " page_count, status) VALUES (?, ?, 'UPLOAD', 'INVOICE', '[]', 1, 'EXTRACTED')",
            (_doc_id, _prj_id),
        )
        con.execute(
            "INSERT INTO doc_headers (document_id, doc_kind, doc_number, total_value)"
            " VALUES (?, 'INVOICE', 'INV-1', 100)",
            (_doc_id,),
        )
        con.execute(
            "INSERT INTO doc_lines (document_id, line_no, description_raw, quantity)"
            " VALUES (?, 1, 'Old Description', 5)",
            (_doc_id,),
        )

        apply_edits(
            con, _doc_id,
            {"doc_number": "INV-1-CORRECTED", "doc_date_raw": "05-Mar-2020", "not_a_real_field": "x"},
            [{
                "line_no": 1, "quantity": 6, "material_id": "MAT-OPC-CEMENT-53-GRADE",
                "description_raw": "Old Description",
            }],
        )
        header = con.execute(
            "SELECT * FROM doc_headers WHERE document_id = ?", (_doc_id,)
        ).fetchone()
        assert header["doc_number"] == "INV-1-CORRECTED"
        assert header["doc_date"] == "2020-03-05", "doc_date_raw edit must re-derive doc_date"
        line = con.execute(
            "SELECT * FROM doc_lines WHERE document_id = ? AND line_no = 1", (_doc_id,)
        ).fetchone()
        assert line["quantity"] == 6
        assert line["material_id"] == "MAT-OPC-CEMENT-53-GRADE"
        # A material correction on a line must be learned for next time too.
        assert match_material(con, "Old Description") == "MAT-OPC-CEMENT-53-GRADE"

        # Clearing a line's material (reviewer picks "unmatched") must not try
        # to learn a NULL alias and crash the material_aliases NOT NULL column.
        apply_edits(con, _doc_id, {}, [{"line_no": 1, "material_id": None, "description_raw": "Old Description"}])
        assert con.execute(
            "SELECT material_id FROM doc_lines WHERE document_id = ? AND line_no = 1", (_doc_id,)
        ).fetchone()["material_id"] is None

        try:
            apply_edits(con, _doc_id, {}, [{"quantity": 1}])   # no line_no
        except ValueError:
            pass
        else:
            raise AssertionError("a line edit with no line_no must be rejected")

        assert claim_for_edit(con, _doc_id) is True, "an EXTRACTED doc must be claimable for edit"

        assert mark_approved(con, _doc_id, "selfcheck") is True
        assert con.execute(
            "SELECT status FROM documents WHERE id = ?", (_doc_id,)
        ).fetchone()["status"] == "APPROVED"

        # Once decided, none of these may act again — each must be a no-op
        # that reports failure, not a second write that undoes the decision.
        assert claim_for_edit(con, _doc_id) is False, "an APPROVED doc must not be editable"
        assert mark_approved(con, _doc_id, "someone-else") is False, "cannot approve twice"
        reviewed_at_1 = con.execute(
            "SELECT reviewed_by, reviewed_at FROM doc_headers WHERE document_id = ?", (_doc_id,)
        ).fetchone()
        assert reviewed_at_1["reviewed_by"] == "selfcheck", "a second approve must not overwrite the first"

        assert mark_rejected(con, _doc_id, "selfcheck", "wrong vendor") is False, \
            "an already-APPROVED document must not be rejectable out from under itself"
        row = con.execute(
            "SELECT d.status, h.rejection_reason FROM documents d"
            " JOIN doc_headers h ON h.document_id = d.id WHERE d.id = ?", (_doc_id,)
        ).fetchone()
        assert row["status"] == "APPROVED", "a failed reject must not have changed the status"
        assert row["rejection_reason"] is None

        # Re-queuing extraction on an already-decided document must be a
        # silent no-op, not a network call and not a status change — this is
        # process()'s own guard, exercised directly with no credentials
        # needed since it returns before run_engine is ever reached.
        process(_doc_id)
        assert con.execute(
            "SELECT status FROM documents WHERE id = ?", (_doc_id,)
        ).fetchone()["status"] == "APPROVED", "process() must refuse to re-run on an APPROVED doc"

        # The direct EXTRACTED -> REJECTED path, tested independently of approve.
        _doc_id_2 = "DOC-selfcheck-2"
        con.execute(
            "INSERT INTO documents (id, project_id, source, document_type, file_paths,"
            " page_count, status) VALUES (?, ?, 'UPLOAD', 'INVOICE', '[]', 1, 'EXTRACTED')",
            (_doc_id_2, _prj_id),
        )
        con.execute("INSERT INTO doc_headers (document_id) VALUES (?)", (_doc_id_2,))
        assert mark_rejected(con, _doc_id_2, "selfcheck", "wrong vendor") is True
        row = con.execute(
            "SELECT d.status, h.rejection_reason FROM documents d"
            " JOIN doc_headers h ON h.document_id = d.id WHERE d.id = ?", (_doc_id_2,)
        ).fetchone()
        assert row["status"] == "REJECTED"
        assert row["rejection_reason"] == "wrong vendor"

        # A document the classifier couldn't place — document_type still
        # UNCLASSIFIED — must not be approvable, and the attempt must not have
        # written anything (status stays EXTRACTED, not silently rejected).
        _doc_id_3 = "DOC-selfcheck-3"
        con.execute(
            "INSERT INTO documents (id, project_id, source, document_type, file_paths,"
            " page_count, status) VALUES (?, ?, 'UPLOAD', 'UNCLASSIFIED', '[]', 1, 'EXTRACTED')",
            (_doc_id_3, _prj_id),
        )
        con.execute("INSERT INTO doc_headers (document_id) VALUES (?)", (_doc_id_3,))
        assert mark_approved(con, _doc_id_3, "selfcheck") is False, \
            "an UNCLASSIFIED document must not be approvable"
        assert con.execute(
            "SELECT status FROM documents WHERE id = ?", (_doc_id_3,)
        ).fetchone()["status"] == "EXTRACTED", "a failed approve must not have changed the status"
        # OTHER is blocked the same way — it isn't a real business type
        # either, just the RA-bill/works-contract bucket, so it needs the
        # same active reclassification (or a reject) before it can be filed.
        _doc_id_4 = "DOC-selfcheck-4"
        con.execute(
            "INSERT INTO documents (id, project_id, source, document_type, file_paths,"
            " page_count, status) VALUES (?, ?, 'UPLOAD', 'OTHER', '[]', 1, 'EXTRACTED')",
            (_doc_id_4, _prj_id),
        )
        con.execute("INSERT INTO doc_headers (document_id) VALUES (?)", (_doc_id_4,))
        assert mark_approved(con, _doc_id_4, "selfcheck") is False, \
            "an OTHER document must not be approvable either"

        # Picking a type is exactly what unblocks it — apply_edits already
        # syncs documents.document_type from doc_kind (see the edit above).
        apply_edits(con, _doc_id_3, {"doc_kind": "DELIVERY"}, [])
        assert mark_approved(con, _doc_id_3, "selfcheck") is True, \
            "approval must succeed once a type is picked"
        # QUOTATION is a real pick too, not just the original three.
        apply_edits(con, _doc_id_4, {"doc_kind": "QUOTATION"}, [])
        assert mark_approved(con, _doc_id_4, "selfcheck") is True, \
            "approval must succeed once reclassified to QUOTATION"

        # An INVOICE additionally needs a po_number before it can be filed —
        # without one it can never be grouped with its PO or its other copy.
        _doc_id_5 = "DOC-selfcheck-5"
        con.execute(
            "INSERT INTO documents (id, project_id, source, document_type, file_paths,"
            " page_count, status) VALUES (?, ?, 'UPLOAD', 'INVOICE', '[]', 1, 'EXTRACTED')",
            (_doc_id_5, _prj_id),
        )
        con.execute("INSERT INTO doc_headers (document_id, doc_kind) VALUES (?, 'INVOICE')", (_doc_id_5,))
        assert mark_approved(con, _doc_id_5, "selfcheck") is False, \
            "an INVOICE with no po_number must not be approvable"
        con.execute("UPDATE doc_headers SET po_number = 'PO-1042' WHERE document_id = ?", (_doc_id_5,))
        assert mark_approved(con, _doc_id_5, "selfcheck") is True, \
            "approval must succeed once po_number is filled in"

        con.execute("DELETE FROM material_aliases WHERE alias = 'old description'")
        con.execute(
            "DELETE FROM documents WHERE id IN (?, ?, ?, ?, ?)",
            (_doc_id, _doc_id_2, _doc_id_3, _doc_id_4, _doc_id_5),
        )
        con.execute("DELETE FROM projects WHERE id = ?", (_prj_id,))

    # A classified kind files the document; anything unexpected stays
    # UNCLASSIFIED rather than tripping the CHECK constraint.
    assert "OTHER" in DOC_TYPES and "INVOICE" in DOC_TYPES
    assert "RA_BILL" not in DOC_TYPES, "an unknown kind must fall back, not be stored"

    # run_engine refuses before it can reach the network: no credentials, or a
    # page that is not on disk. Either way the self-check makes no API call.
    try:
        run_engine(["nope.jpg"], "INVOICE")
    except (EngineNotConfigured, FileNotFoundError):
        pass
    else:
        raise AssertionError("run_engine read a page that does not exist")

    try:
        run_engine([], "INVOICE")
    except (EngineNotConfigured, ValueError):
        pass
    else:
        raise AssertionError("a document with no pages must not be extracted")

    # The engine contract is the schema the model is held to — a drifted field
    # name here is a silent extraction failure, so pin the shape.
    assert Extraction.model_fields.keys() >= {
        "doc_kind", "doc_number", "po_number", "doc_date_raw", "vendor_gstin",
        "tax_type", "tcs_amount", "rounding_off", "total_value", "lines",
    }
    assert "dc_number" in Line.model_fields, "invoice lines carry their own D.C.No"
    # Structured output is strict: every field must be required and nullable, or
    # the model is free to omit one and the parse fails on a real document.
    _schema = Extraction.model_json_schema()
    assert set(_schema["required"]) == set(_schema["properties"]), "all fields must be required"

    # Page encoding: a PDF is a document block, an image is an image block, and
    # anything else is refused rather than sent as garbage the model can't read.
    _scratch = BASE_DIR / "uploads" / "_selfcheck"
    _scratch.mkdir(parents=True, exist_ok=True)
    try:
        (_scratch / "a.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        (_scratch / "b.pdf").write_bytes(b"%PDF-1.4")
        (_scratch / "c.txt").write_bytes(b"nope")

        pages = _blocks(["uploads/_selfcheck/a.png", "uploads/_selfcheck/b.pdf"])
        assert [p["type"] for p in pages] == ["image", "document"], pages
        assert pages[0]["source"]["media_type"] == "image/png"
        assert pages[1]["source"]["media_type"] == "application/pdf"
        # Order is the page order — a reordered multi-page invoice reads wrong.
        assert base64.b64decode(pages[0]["source"]["data"]).startswith(b"\x89PNG")

        for _path, _exc in [("uploads/_selfcheck/c.txt", ValueError),
                            ("uploads/_selfcheck/gone.jpg", FileNotFoundError)]:
            try:
                _blocks([_path])
            except _exc:
                pass
            else:
                raise AssertionError(f"{_path} should have raised {_exc.__name__}")
    finally:
        for _f in _scratch.iterdir():
            _f.unlink()
        _scratch.rmdir()

    print("extract self-check passed")
