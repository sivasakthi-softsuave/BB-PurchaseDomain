/* Formatting, derivation and lookup helpers shared across tabs. No JSX. */

export const inr = (n) =>
  n == null || n === ""
    ? "—"
    : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const money = (n) => (n == null || n === "" ? null : `₹${inr(n)}`);

/* Chart axes and bar labels need a number that fits in a handful of
   characters — "₹11.2L" reads at a glance where the exact-rupee money()
   above would crowd a bar chart's whole x-axis. */
export const compactMoney = (n) => {
  const v = Number(n) || 0;
  const trimmed = (num) => (Number.isInteger(num) ? String(num) : num.toFixed(1));
  if (v >= 1e7) return `₹${trimmed(v / 1e7)}Cr`;
  if (v >= 1e5) return `₹${trimmed(v / 1e5)}L`;
  if (v >= 1e3) return `₹${trimmed(v / 1e3)}K`;
  return `₹${Math.round(v)}`;
};

export const qty = (n) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

export const kb = (n) =>
  n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/* "2026-08-24 19:03:27" -> "24 Aug". The full stamp is still on the review
   sheet; a list only needs enough to tell one day from another. */
export const shortDate = (stamp) => {
  const d = new Date(String(stamp).replace(" ", "T"));
  return Number.isNaN(d.getTime())
    ? String(stamp).slice(0, 10)
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};

/* Same as shortDate but with the year — a timeline spanning more than one
   year needs it; a list of a single project's own recent documents doesn't. */
export const longDate = (stamp) => {
  const d = new Date(String(stamp).replace(" ", "T"));
  return Number.isNaN(d.getTime())
    ? String(stamp).slice(0, 10)
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

/* Same idea, but with the time too — for an event log (Delivery Timeline)
   where two things happening on the same day still need telling apart. */
export const dateTime = (stamp) => {
  const d = new Date(String(stamp).replace(" ", "T"));
  return Number.isNaN(d.getTime())
    ? String(stamp).slice(0, 16)
    : d.toLocaleString("en-IN", {
        day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
      });
};

/* A Delivery Timeline event's own trailing timestamp — "4 hours ago" for
   anything that happened in the last day, since that's still legible at a
   glance; the full date once it's further back than that, the same as any
   other timestamp on this screen.

   A Delivery Timeline event mixes two shapes of stamp: uploaded_at ("2026-
   09-26 11:51:27", genuinely UTC but carrying no offset of its own) and
   reviewed_at/edited_at/deleted_at ("...T11:51:39+00:00", explicit UTC).
   Left alone, a viewer not themselves on UTC has every uploaded_at parsed
   as *local* time instead — silently shifting "captured" by the viewer's
   own UTC offset relative to the others, so this forces +00:00 onto
   whichever stamp doesn't already carry its own offset. */
export const eventTime = (stamp) => {
  const iso = String(stamp).replace(" ", "T");
  const d = new Date(/[+-]\d\d:\d\d$|Z$/.test(iso) ? iso : `${iso}+00:00`);
  if (Number.isNaN(d.getTime())) return String(stamp);

  const hours = (Date.now() - d.getTime()) / 3_600_000;
  if (hours >= 0 && hours < 24) {
    if (hours < 1) {
      const minutes = Math.max(1, Math.floor(hours * 60));
      return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    }
    const wholeHours = Math.floor(hours);
    return `${wholeHours} hour${wholeHours === 1 ? "" : "s"} ago`;
  }
  return dateTime(stamp);
};

export const projectOf = (doc) =>
  doc.project_code ? `${doc.project_code} — ${doc.project_name}` : "—";

/* The reference printed on the paper, whichever kind of paper it is. */
export const refOf = (doc) => doc.doc_number || doc.po_number || null;

/* A digit misread breaks these identities almost every time — not a
   guess, just checking what the document itself already implies:
   quantity × rate = amount, and basic value + tax + tcs + rounding = total.
   Tolerance covers real per-line rounding, not a genuine mismatch. */
const numbersClose = (a, b) => Math.abs(a - b) <= Math.max(1, Math.max(Math.abs(a), Math.abs(b)) * 0.01);

export function checkArithmetic(header, lines) {
  const badLines = (lines ?? [])
    .filter((l) => l.quantity != null && l.rate != null && l.amount != null && l.quantity !== "" && l.rate !== "" && l.amount !== "")
    .filter((l) => !numbersClose(Number(l.quantity) * Number(l.rate), Number(l.amount)))
    .map((l) => l.line_no);

  const h = header ?? {};
  const parts = [h.basic_value, h.igst_amount, h.cgst_amount, h.sgst_amount, h.tcs_amount, h.rounding_off]
    .map((v) => (v == null || v === "" ? 0 : Number(v)));
  const headerMismatch =
    h.basic_value != null && h.basic_value !== "" && h.total_value != null && h.total_value !== ""
    && !numbersClose(parts.reduce((a, b) => a + b, 0), Number(h.total_value));

  return { badLines, headerMismatch };
}

export const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
export const ALLOWED_UPLOAD_RE = /\.(pdf|jpe?g|png)$/i;

export const DOC_TYPES = [
  "INVOICE", "PO", "DELIVERY", "QUOTATION", "INWARD", "PURCHASE_BILL", "OTHER", "UNCLASSIFIED",
];

// Display text only — the enum value stored everywhere (doc_kind, document_type,
// the DB, po_reconciliation's grouping) stays INWARD/PURCHASE_BILL unchanged.
// This client calls an INWARD document a "MIN Voucher" — shown as the shorter
// "MIN" so it fits a pill and a select option the same way every other type does.
export const DOC_TYPE_LABELS = {
  INVOICE: "Invoice", PO: "PO", DELIVERY: "Delivery", QUOTATION: "Quotation",
  INWARD: "MIN", PURCHASE_BILL: "Purchase Bill", OTHER: "Other", UNCLASSIFIED: "Unclassified",
};
export const docTypeLabel = (t) => DOC_TYPE_LABELS[t] ?? t;
export const DOC_STATUSES = [
  "DRAFT", "PENDING", "PROCESSING", "EXTRACTED", "APPROVED", "REJECTED", "FAILED",
];

export const titleCase = (s) => s.charAt(0) + s.slice(1).toLowerCase();

/* EXTRACTED reads as "pending" because it still needs a human — the document
   is done being read, not done being handled. */
const STATUS_CLASS = {
  DRAFT: "s-draft",
  PENDING: "s-pending",
  PROCESSING: "s-working",
  EXTRACTED: "s-pending",
  APPROVED: "s-approved",
  REJECTED: "s-rejected",
  FAILED: "s-failed",
};
export const statusClass = (status) => STATUS_CLASS[status] ?? "s-pending";

export const isWaiting = (doc) => doc.status === "PENDING" || doc.status === "PROCESSING";
export const isDraft = (doc) => doc.status === "DRAFT";
export const isLocked = (doc) => doc.status === "APPROVED" || doc.status === "REJECTED";
/* "Awaiting review" means a person, not a machine: extraction is finished and
   the document is sitting there wanting a decision. */
export const needsDecision = (doc) => doc.status === "EXTRACTED";

export const isRejected = (doc) => doc.status === "REJECTED";
/* A rejected document stays visible in every list — that is the audit trail —
   but it is a document the business has decided not to accept, so its money
   and its materials must not reach any total. Every aggregate filters through
   this one predicate rather than each re-testing the status string. */
export const countsTowardTotals = (doc) => !isRejected(doc);

/* ── project health ───────────────────────────────────────────────────────
   Lets a portfolio be scanned without opening anything. Order matters: a
   project with something waiting on a person outranks one still reading. */
export function projectStatus(project, docs) {
  const mine = docs.filter((d) => d.project_id === project.id);
  if (mine.some(needsDecision)) return { cls: "st-action", label: "Action required", dot: "d-hot" };
  if (mine.some(isWaiting))     return { cls: "st-proc",   label: "Processing",      dot: "d-ink" };
  if (mine.length)              return { cls: "st-track",  label: "On track",        dot: "d-ok" };
  return { cls: "st-none", label: "No activity", dot: "d-mute" };
}

export function projectTally(project, docs) {
  const mine = docs.filter((d) => d.project_id === project.id);
  const counted = mine.filter(countsTowardTotals);
  return {
    documents: mine.length,
    pages: mine.reduce((n, d) => n + (d.page_count ?? 0), 0),
    awaiting: mine.filter(needsDecision).length,
    pos: mine.filter((d) => d.document_type === "PO").length,
    // Rejected documents are excluded: the project did not buy that.
    booked: counted.reduce((sum, d) => sum + (Number(d.total_value) || 0), 0),
    reading: mine.filter(isWaiting).length,
    rejected: mine.length - counted.length,
  };
}

/* What a document did, in the words a person would use for it. */
export function activityOf(doc) {
  const kind = titleCase(doc.document_type ?? "Document");
  const value = money(doc.total_value);
  switch (doc.status) {
    case "APPROVED":
      return { dot: "d-ok", what: value ? `${kind} approved · ${value}` : `${kind} approved` };
    case "REJECTED":
      return { dot: "d-no", what: `${kind} rejected` };
    case "EXTRACTED":
      return { dot: "d-hot", what: "Read — waiting on your decision" };
    case "FAILED":
      return { dot: "d-no", what: `Could not be read — ${doc.error || "unknown error"}` };
    case "DRAFT":
      return { dot: "d-mute", what: `${kind} saved as draft` };
    default:
      return { dot: "d-ink", what: `${kind} being read` };
  }
}

/* ── month-over-month trend ───────────────────────────────────────────────
   The home dashboard's KPIs are running totals (all documents ever captured,
   all money ever booked), so the honest comparison is "this running total vs.
   what it stood at the end of last month" — not this-month-flow vs.
   last-month-flow, which would answer a different question than the one the
   card's own number is asking. valueOf lets one helper serve a plain count
   (default: 1 per row) and a sum (total_value) alike. */
export function trendVsLastMonth(items, dateKey, valueOf = () => 1) {
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);

  let total = 0;
  let before = 0;
  for (const item of items) {
    const day = String(item[dateKey] || "").slice(0, 10);
    const v = valueOf(item);
    total += v;
    if (day && day <= cutoff) before += v;
  }

  // `short` is the bold, colored delta a KPI card shows inline; `caption` is
  // the same trailing phrase every case shares, so the two read as one
  // sentence ("↑ +25%  since last month") without the card needing to know
  // which case produced it.
  if (before <= 0) return total > 0 ? { short: "New", caption: "since last month", tone: "ok" } : null;
  const pct = Math.round(((total - before) / before) * 100);
  if (pct === 0) return { short: "No change", caption: "since last month", tone: "flat" };
  return {
    short: `${pct > 0 ? "↑" : "↓"} ${pct > 0 ? "+" : ""}${pct}%`,
    caption: "since last month",
    tone: pct > 0 ? "ok" : "bad",
  };
}

/* Shared by the project detail and material tabs so both filter identically. */
export function matchesFilter(doc, f = {}) {
  if (f.project && doc.project_id !== f.project) return false;
  if (f.type && doc.document_type !== f.type) return false;
  if (f.status && doc.status !== f.status) return false;
  const day = (doc.uploaded_at || "").slice(0, 10);
  if (f.from && day < f.from) return false;
  if (f.to && day > f.to) return false;
  if (f.q) {
    const hay = `${doc.document_id} ${projectOf(doc)} ${doc.vendor_name ?? ""} ${refOf(doc) ?? ""}`;
    if (!hay.toLowerCase().includes(f.q.toLowerCase())) return false;
  }
  return true;
}
