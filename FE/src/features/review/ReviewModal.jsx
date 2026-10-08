import { useCallback, useEffect, useState } from "react";
import { Modal } from "../../components/Modal.jsx";
import { HeaderFields } from "./HeaderFields.jsx";
import { LineItems } from "./LineItems.jsx";
import { openPurchaseBillTab, PurchaseBillPreview, PurchaseBillVoucher } from "./PurchaseBillVoucher.jsx";
import { HEADER_KEYS, LINE_FIELDS } from "./schema.js";
import { IconEdit } from "../../components/Icons.jsx";
import { api } from "../../lib/api.js";
import { checkArithmetic, isLocked, isWaiting, money, projectOf, qty } from "../../lib/format.js";
import { gstinChecksumOk, gstinIsSelf } from "../../lib/gstin.js";

const blank = (v) => (typeof v === "string" && v.trim() === "" ? null : v === "" ? null : v);

/* What gets PUT: every field the form owns, with empties normalised to null so
   clearing a wrong value actually clears it server-side. */
function buildEdits(draft) {
  const header = {};
  HEADER_KEYS.forEach((key) => { header[key] = blank(draft.header[key] ?? ""); });

  const lines = draft.lines.map((line) => {
    const out = { line_no: line.line_no };
    LINE_FIELDS.forEach((f) => { out[f.key] = blank(line[f.key] ?? ""); });
    return out;
  });

  return { header, lines };
}

/* Which fields a document can never be approved without, by its own kind —
   each one is a reference this client's own three-way match (see
   po_reconciliation) depends on to thread documents together:
     PO             its own number — nothing references a PO that has none.
     INVOICE/DELIVERY  the PO it was delivered against.
     INWARD (MIN)   the PO, its own MIN No (doc_number), and the invoice
                    it received against (dc_number).
     PURCHASE_BILL  the PO, its own PV/PB No (doc_number), the invoice
                    (dc_number) and the MIN it was closed from (min_number).
   Mirrored server-side in extract.mark_approved — this only gets the
   Approve button disabled with the right reason before the request goes,
   the server gate is what actually holds. */
const REQUIRED_FIELDS_BY_KIND = {
  PO: ["doc_number"],
  INVOICE: ["po_number"],
  DELIVERY: ["po_number"],
  INWARD: ["po_number", "doc_number", "dc_number"],
  PURCHASE_BILL: ["po_number", "doc_number", "dc_number", "min_number"],
};

/* The completeness gates a document can be stuck behind — shared by the
   Approve button (disabled), the banners (why), and the close handler
   below (blocks dismissal on the one that matters there). */
function gatesFor(header) {
  const typeUnset = !header?.doc_kind || header.doc_kind === "UNCLASSIFIED";
  const typeOther = header?.doc_kind === "OTHER";
  const missingFields = (REQUIRED_FIELDS_BY_KIND[header?.doc_kind] ?? [])
    .filter((f) => !String(header?.[f] ?? "").trim());
  return {
    typeUnset, typeOther, typeMissing: typeUnset || typeOther,
    missingFields,
    // Kept as its own flag — existing callers (Save's disabled/title, the
    // close handler) only ever cared about po_number specifically.
    poNumberMissing: missingFields.includes("po_number"),
  };
}

export function ReviewModal({ docId, docs, materials, onClose, onChanged }) {
  const [doc, setDoc] = useState(null);
  const [draft, setDraft] = useState(null);
  const [reviewer, setReviewer] = useState(() => localStorage.getItem("reviewerName") ?? "");
  const [rejecting, setRejecting] = useState(false);
  /* Reopens an APPROVED document's form for a correction, without moving it
     back to EXTRACTED — see the pencil on StatusBanner's "Approved" case and
     the Save/Cancel swap in DecisionFooter below. Only ever true for a
     document that is (still) APPROVED; never set for EXTRACTED/REJECTED. */
  const [editingApproved, setEditingApproved] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState(null);
  const [lineIssues, setLineIssues] = useState({});

  /* Load, then re-read only while extraction is still running — the loop
     schedules its own next tick and so stops itself the moment the document
     settles. Nothing polls once the form is on screen, which is what keeps a
     refresh from discarding edits in progress. */
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let watched = false;

    const read = async () => {
      const fresh = await api.getDocument(docId).catch(() => null);
      if (cancelled || !fresh) return;
      setDoc(fresh);

      if (isWaiting(fresh)) {
        watched = true;
        timer = setTimeout(read, 3000);
      } else if (watched) {
        onChanged();      // extraction finished while open — refresh the lists
      }
    };

    read();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [docId, onChanged]);

  useEffect(() => {
    if (!doc || isWaiting(doc) || isLocked(doc)) return;
    setDraft((prev) => prev ?? {
      header: { ...(doc.header ?? {}) },
      lines: (doc.lines ?? []).map((l) => ({ ...l })),
    });
  }, [doc]);

  /* The same delivery uploaded a second time — same vendor + invoice
     number, paired automatically at extraction time (extract.find_duplicate).
     Fetched once the document itself has settled; most invoices have no
     paired copy at all, in which case duplicate_of comes back null and
     nothing renders. */
  useEffect(() => {
    if (!doc || isWaiting(doc) || doc.status === "FAILED") { setDiff(null); return; }
    let cancelled = false;
    api.getDuplicateDiff(docId).then((d) => { if (!cancelled) setDiff(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [docId, doc?.status]);

  /* What the other documents of this one's own delivery say about its lines
     — marked on the lines themselves (see LineItems' lineIssues). Empty for
     anything that isn't part of a delivery, so most documents fetch this
     once and render nothing extra. */
  useEffect(() => {
    if (!doc || isWaiting(doc) || doc.status === "FAILED") { setLineIssues({}); return; }
    let cancelled = false;
    api.getLineIssues(docId).then((i) => { if (!cancelled) setLineIssues(i); }).catch(() => {});
    return () => { cancelled = true; };
  }, [docId, doc?.status]);

  const setHeader = (key, value) =>
    setDraft((d) => ({ ...d, header: { ...d.header, [key]: value } }));

  const setLine = (lineNo, key, value) =>
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l) => (l.line_no === lineNo ? { ...l, [key]: value } : l)),
    }));

  const save = useCallback(async ({ silent = false, extra = {} } = {}) => {
    setErr("");
    try {
      const updated = await api.saveDocument(docId, { ...buildEdits(draft), ...extra });
      if (!silent) { setDoc(updated); onChanged(); }
      return updated;
    } catch (e) {
      setErr(`Could not save — ${e.message}`);
      return null;
    }
  }, [docId, draft, onChanged]);

  const rememberReviewer = () => {
    const name = reviewer.trim();
    if (name) localStorage.setItem("reviewerName", name);
    return name;
  };

  /* Pencil on the Approved banner — snapshots the document's current
     (already-approved) values into draft so editing starts from what's
     actually on file, not whatever a previous edit-then-cancel left behind. */
  const beginEditApproved = () => {
    setErr("");
    setDraft({
      header: { ...(doc.header ?? {}) },
      lines: (doc.lines ?? []).map((l) => ({ ...l })),
    });
    setEditingApproved(true);
  };

  /* Same "enter your name first" gate Approve has always had — see decide()
     below — applied to this Save instead, since this is the one Save that
     actually changes an already-decided document. Records the name onto
     reviewed_by/reviewed_at (server side) and drops back to the read-only
     Approved view on success; a failed save leaves editing open so nothing
     is silently lost. */
  const saveApprovedEdit = async () => {
    const name = rememberReviewer();
    if (!name) { setErr("Enter your name first."); return; }
    setBusy(true);
    const ok = await save({ extra: { edited_by: name } });
    setBusy(false);
    if (ok) setEditingApproved(false);
  };

  /* No save call at all — locked flips back on, so the header/lines below
     render straight from doc again and whatever was typed into draft during
     this edit session is simply never read. */
  const cancelEditApproved = () => {
    setErr("");
    setEditingApproved(false);
  };

  const decide = async (kind) => {
    const name = rememberReviewer();
    if (!name) { setErr("Enter your name first."); return; }
    if (kind === "reject" && !reason.trim()) {
      setErr("A rejection reason is required.");
      return;
    }

    setBusy(true);
    /* Edits are saved before the verdict, so what gets approved is what is on
       screen — not the extractor's original guess. */
    if (!(await save({ silent: true }))) { setBusy(false); return; }

    try {
      const updated = kind === "approve"
        ? await api.approveDocument(docId, name)
        : await api.rejectDocument(docId, name, reason.trim());
      setDoc(updated);
      onChanged();
    } catch (e) {
      setErr(`Could not ${kind} — ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    await api.retryExtraction(docId);
    setDoc(await api.getDocument(docId).catch(() => doc));
    onChanged();
  };

  /* The one thing this refuses to do is close while extraction is still
     running — there's nothing to review yet, and a reviewer who dismisses
     it now has no way back to it except finding it again in a list, so
     Escape, the X and the backdrop all do nothing until the document
     settles into EXTRACTED (or FAILED, which is as settled as a broken
     document gets). See the `closable` prop on Modal below for the other
     half of this — the X itself is disabled too, so it doesn't sit there
     looking clickable while doing nothing.

     Past that, closing never saves — only an explicit Save/Approve click
     does (see DecisionFooter). A reviewer who closes without clicking
     either walks away with nothing written: the document sits exactly
     where it was (EXTRACTED, unreviewed) for whoever opens it next. */
  const attemptClose = () => {
    if (doc && isWaiting(doc)) return;
    onClose();
  };

  const subtitle = doc ? `${doc.document_id} — ${projectOf(doc)}` : docId;
  const locked = doc ? isLocked(doc) && !editingApproved : false;
  const header = locked ? (doc?.header ?? {}) : draft?.header;
  /* header can be briefly undefined even once doc.status is EXTRACTED — the
     poll's setDoc(fresh) and the effect that populates draft from it commit
     on two different renders, and gatesFor(header) has to survive the one
     in between rather than forcing every caller to null-check gates. */
  const gates = header ? gatesFor(header) : gatesFor({});
  const showFooter = doc && !isWaiting(doc) && doc.status !== "FAILED" && !locked && Boolean(header);

  /* Every PO already on file in this same document's project — not other
     projects, since a PO number only ever means something within the one
     project it was raised for. Offered as suggestions, not a restriction:
     the field stays free text (see HeaderFields' fieldOptions), so typing a
     number that genuinely isn't uploaded yet still works. */
  const poNumberOptions = doc
    ? [...new Set(
        (docs ?? [])
          .filter((d) => d.project_id === doc.project_id && d.document_type === "PO" && d.doc_number)
          .map((d) => d.doc_number)
      )]
    : [];

  /* Only meaningful on an INWARD/PURCHASE_BILL page — see schema.js's
     dc_number label — and only once a PO number is actually on the form:
     an invoice not yet tied to that same PO isn't the one this document is
     closing out, so it's not offered. Reads header.po_number (the live
     draft, not doc's original value) so picking a different PO re-scopes
     the suggestions immediately, not just after a save. */
  const dcNumberOptions =
    doc && ["INWARD", "PURCHASE_BILL"].includes(header?.doc_kind) && header?.po_number
      ? [...new Set(
          (docs ?? [])
            .filter((d) =>
              d.project_id === doc.project_id && d.document_type === "INVOICE"
              && d.po_number === header.po_number && d.doc_number
            )
            .map((d) => d.doc_number)
        )]
      : [];

  /* A MIN Voucher's own number is its doc_number, not dc_number — see
     REQUIRED_FIELDS_BY_KIND's note on INWARD above — so a Purchase Bill's
     min_number is suggested from INWARD documents the same way dc_number is
     suggested from INVOICE documents: same project, same PO. Only offered
     once a PO number is on the form, for the same reason dcNumberOptions
     waits for one — an INWARD not yet tied to that PO isn't the MIN this
     bill was closed from. */
  const minNumberOptions =
    doc && header?.doc_kind === "PURCHASE_BILL" && header?.po_number
      ? [...new Set(
          (docs ?? [])
            .filter((d) =>
              d.project_id === doc.project_id && d.document_type === "INWARD"
              && d.po_number === header.po_number && d.doc_number
            )
            .map((d) => d.doc_number)
        )]
      : [];

  return (
    <Modal
      title="Review document"
      subtitle={subtitle}
      wide
      closable={!doc || !isWaiting(doc)}
      onClose={attemptClose}
      headerExtra={doc?.status === "APPROVED" && !editingApproved ? (
        <button
          type="button"
          className="icon-btn-bare"
          onClick={beginEditApproved}
          title="Edit this document"
          aria-label="Edit this document"
        >
          <IconEdit width={26} height={26} />
        </button>
      ) : null}
      footer={showFooter ? (
        <DecisionFooter
          reviewer={reviewer}
          setReviewer={setReviewer}
          busy={busy}
          gates={gates}
          editingApproved={editingApproved}
          onSave={editingApproved ? saveApprovedEdit : async () => {
            setBusy(true);
            const ok = await save();
            setBusy(false);
            if (ok) onClose();
          }}
          onApprove={() => decide("approve")}
          onReject={() => setRejecting(true)}
          onCancel={cancelEditApproved}
        />
      ) : null}
    >
      {!doc ? <div className="empty">Loading…</div> : (
        <>
          {doc.file_paths.length > 1 ? (
            <div className="doc-pages-count">{doc.file_paths.length} pages</div>
          ) : null}
          <div className="doc-pages">
            {doc.file_paths.map((path, i) => (
              <a key={path} href={`/${path}`} target="_blank" rel="noopener noreferrer">
                <img src={`/${path}`} alt={`page ${i + 1}`} />
              </a>
            ))}
            {/* A generated Purchase Bill (see ComparePage's Generate
                Purchase Bill) never had a paper page to scan — file_paths
                is empty — so it gets the same thumbnail-sized slot every
                other document's own page image sits in here, not a full
                inline render of the voucher. A scanned Purchase Bill
                already has its own real page image above and skips this. */}
            {header?.doc_kind === "PURCHASE_BILL" && !doc.file_paths.length ? (
              <button
                type="button"
                className="pb-thumb"
                title="Open in a new tab"
                onClick={() => openPurchaseBillTab({
                  header,
                  lines: locked ? (doc.lines ?? []) : draft?.lines,
                  materials,
                  project: { code: doc.project_code, name: doc.project_name },
                })}
              >
                <PurchaseBillPreview
                  header={header}
                  lines={locked ? (doc.lines ?? []) : draft?.lines}
                  materials={materials}
                  project={{ code: doc.project_code, name: doc.project_name }}
                />
              </button>
            ) : null}
          </div>

          {header?.doc_kind === "PURCHASE_BILL" ? (
            <>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
                <button type="button" className="btn btn-out btn-sm" onClick={() => window.print()}>
                  Print Purchase Bill
                </button>
              </div>
              <PurchaseBillVoucher
                header={header}
                lines={locked ? (doc.lines ?? []) : draft?.lines}
                materials={materials}
                project={{ code: doc.project_code, name: doc.project_name }}
              />
            </>
          ) : null}

          <StatusBanner doc={doc} onRetry={retry} />

          {isWaiting(doc) || doc.status === "FAILED" ? null : (
            <>
              <ScanQualityBanner
                header={header}
                lines={locked ? (doc.lines ?? []) : draft?.lines}
                gates={gates}
                onRetry={retry}
              />
              {/* What's left up here is deliberately only what *isn't* about
                  one field: this document against another copy of itself, and
                  the page as a whole. The GSTIN check digit and an unknown PO
                  number now sit on their own fields instead — see
                  fieldErrorsFor. */}
              <DuplicateDiffBanner diff={diff} />
              <ArithmeticBanner header={header} lines={locked ? (doc.lines ?? []) : draft?.lines} />
              <Body
                header={header}
                lines={locked ? (doc.lines ?? []) : draft?.lines}
                locked={locked}
                gates={gates}
                poNumberOptions={poNumberOptions}
                dcNumberOptions={dcNumberOptions}
                minNumberOptions={minNumberOptions}
                materials={materials}
                lineIssues={lineIssues}
                rejecting={rejecting}
                reason={reason}
                setReason={setReason}
                err={err}
                busy={busy}
                onHeader={setHeader}
                onLine={setLine}
                onDecide={decide}
              />
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function StatusBanner({ doc, onRetry }) {
  if (isWaiting(doc)) {
    return <div className="banner banner-wait">Extraction in progress… this updates automatically.</div>;
  }
  if (doc.status === "FAILED") {
    return (
      <div className="banner banner-err">
        Extraction failed — {doc.error || "unknown error"}.
        <div style={{ marginTop: 10 }}>
          <button className="btn btn-out" onClick={onRetry}>Retry extraction</button>
        </div>
      </div>
    );
  }
  if (doc.status === "APPROVED") {
    return (
      <div className="banner banner-ok">
        Approved by {doc.header?.reviewed_by} on {doc.header?.reviewed_at}.
      </div>
    );
  }
  if (doc.status === "REJECTED") {
    return (
      <div className="banner banner-err">
        Rejected by {doc.header?.reviewed_by} on {doc.header?.reviewed_at}
        {doc.header?.rejection_reason ? ` — ${doc.header.rejection_reason}` : ""}
      </div>
    );
  }
  return null;
}

/* Most invoices have no paired copy at all — duplicate_of is null and this
   renders nothing. When one exists, it's the same delivery uploaded more
   than once — see extract.compare_document_lines for how "match" is decided. */
function DuplicateDiffBanner({ diff }) {
  if (!diff || !diff.duplicate_of) return null;
  const otherLabel = diff.other_document?.doc_number ?? diff.duplicate_of;

  if (diff.clean) {
    return (
      <div className="banner banner-ok">
        Matches its other copy ({otherLabel}) — same materials, quantities and rates.
      </div>
    );
  }

  // A line missing entirely from one side reads as "missing", not as a
  // "— @ —" mismatch against a value that was never there to disagree with.
  const describe = (l) => {
    const name = l.material_name ?? "Unrecognised material";
    if (l.qty_a == null) return `${name} — not on this copy (other copy has ${qty(l.qty_b)} @ ${money(l.rate_b)})`;
    if (l.qty_b == null) return `${name} — missing from the other copy (this copy has ${qty(l.qty_a)} @ ${money(l.rate_a)})`;
    return `${name} — this copy: ${qty(l.qty_a)} @ ${money(l.rate_a)}, other copy: ${qty(l.qty_b)} @ ${money(l.rate_b)}`;
  };

  return (
    <div className="banner banner-err">
      <div>This invoice doesn't match its other copy ({otherLabel}):</div>
      <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
        {diff.lines.filter((l) => !l.match).map((l) => <li key={l.material_id}>{describe(l)}</li>)}
      </ul>
      {diff.unmatched_a.length || diff.unmatched_b.length ? (
        <div style={{ marginTop: 6 }}>
          {diff.unmatched_a.length
            ? `This copy has ${diff.unmatched_a.length} line${diff.unmatched_a.length === 1 ? "" : "s"} `
              + "that couldn't be matched to a material. "
            : ""}
          {diff.unmatched_b.length
            ? `The other copy has ${diff.unmatched_b.length} line${diff.unmatched_b.length === 1 ? "" : "s"} `
              + "that couldn't be matched to a material."
            : ""}
        </div>
      ) : null}
    </div>
  );
}

/* A referenced PO number that doesn't match any PO actually on file in this
   document's own project — a typo, a number carried over from the wrong job,
   or simply the PO not uploaded here yet. Informational, not a gate: unlike
   poNumberMissing (an empty field) this never blocks Save/Approve, since the
   PO showing up five minutes later is completely normal and shouldn't force
   a reviewer to babysit the upload order. poNumberOptions is already scoped
   to this project (see ReviewModal), so "not in that list" here already
   means "not in this project", not "not anywhere". */
function PoNumberBanner({ header, poNumberOptions }) {
  const referencesPo = ["INVOICE", "DELIVERY", "INWARD", "PURCHASE_BILL"].includes(header?.doc_kind);
  const poNumber = String(header?.po_number ?? "").trim();
  if (!referencesPo || !poNumber || poNumberOptions.includes(poNumber)) return null;

  return (
    <div className="banner banner-warn">
      PO number "{poNumber}" is not present in the current project — double-check it's
      correct, or upload that PO here first.
    </div>
  );
}

/* Several of the checks below can fire at once for one underlying reason:
   the page itself scanned badly. Each of them alone reads as its own small
   problem to go and fix by hand; together they're better read as "this
   photograph is the problem" — and a clearer rescan fixes all of them in one
   go, for less effort than correcting each field. Deliberately built only
   from checks already computed here rather than a new server-side quality
   score: it costs nothing, and it can only ever agree with what the
   reviewer is already being shown.

   Two is the threshold on purpose — any one of these fires routinely on a
   perfectly good scan (a vendor really can print a wrong GSTIN, a total
   really can round oddly), but a page failing two unrelated checks at once
   is usually a page that was hard to read. */
function ScanQualityBanner({ header, lines, gates, onRetry }) {
  const rows = lines ?? [];
  const signals = [];

  if (header?.vendor_gstin && gstinChecksumOk(header.vendor_gstin) === false) {
    signals.push("the vendor GSTIN fails its check digit");
  }
  const { badLines, headerMismatch } = checkArithmetic(header, rows);
  if (headerMismatch || badLines.length) signals.push("the amounts don't add up");
  const unmatched = rows.filter((l) => !l.material_id).length;
  if (unmatched) {
    signals.push(`${unmatched} line${unmatched === 1 ? "" : "s"} couldn't be matched to a material`);
  }
  if (gates?.missingFields?.length) {
    signals.push("a reference number is missing");
  }

  if (signals.length < 2) return null;

  return (
    <div className="banner banner-warn">
      <div>
        This page looks like it scanned poorly — {signals.join(", ")}. A clearer photo or rescan
        is likely to fix these together, and is usually quicker than correcting each field by hand.
      </div>
      <div style={{ marginTop: 10 }}>
        <button className="btn btn-out btn-xs" type="button" onClick={onRetry}>
          Re-read this document
        </button>
      </div>
    </div>
  );
}

/* GSTIN's last character is a real check digit — false here means a
   misread character, not a guess. Checked live against whatever's
   currently in the field (see lib/gstin.js), not the server's
   vendor_gstin_checksum_ok/vendor_gstin_is_self — those describe the
   value at load time and go stale the moment a reviewer corrects it,
   which is exactly when this banner most needs to go away. Non-blocking,
   same as PoNumberBanner. */
function GstinChecksumBanner({ header }) {
  const bad = [];
  if (header?.vendor_gstin && gstinChecksumOk(header.vendor_gstin) === false) bad.push(["Vendor", header.vendor_gstin]);
  if (header?.buyer_gstin && gstinChecksumOk(header.buyer_gstin) === false) bad.push(["Buyer", header.buyer_gstin]);
  if (gstinIsSelf(header?.vendor_gstin)) {
    bad.push(["Vendor-self", header.vendor_gstin]);
  }
  if (!bad.length) return null;

  return (
    <div className="banner banner-warn">
      {bad.map(([label, value]) => (
        <div key={value + label}>
          {label === "Vendor-self"
            ? `Vendor GSTIN "${value}" matches B&B's own registration — vendor and buyer look swapped, please check.`
            : `${label} GSTIN "${value}" fails its check digit — likely a misread character.`}
        </div>
      ))}
    </div>
  );
}

/* Not a claim the numbers are wrong — a document can genuinely round oddly
   — just that they don't add up the way the document itself implies, which
   is worth a second look before saving. Non-blocking, same as the others. */
export function ArithmeticBanner({ header, lines }) {
  const { badLines, headerMismatch } = checkArithmetic(header, lines);
  if (!badLines.length && !headerMismatch) return null;

  return (
    <div className="banner banner-warn">
      {headerMismatch ? (
        <div>The basic value, tax and rounding off don't add up to the total value — please check before saving.</div>
      ) : null}
      {badLines.length ? (
        <div>
          Quantity × rate doesn't match the amount on line{badLines.length > 1 ? "s" : ""}{" "}
          {badLines.join(", ")} — please check before saving.
        </div>
      ) : null}
    </div>
  );
}

/* Reviewer name + Save/Approve/Reject, right-aligned in the modal's own
   footer strip rather than inline in the scrolling body — the actions that
   finish a review stay in the same place regardless of how long the body
   above them gets. */
function DecisionFooter({ reviewer, setReviewer, busy, gates, editingApproved, onSave, onApprove, onReject, onCancel }) {
  return (
    <>
      <input
        className="input"
        style={{ maxWidth: 220 }}
        placeholder="Your name"
        value={reviewer}
        onChange={(e) => setReviewer(e.target.value)}
      />
      <div className="spacer" />
      <button
        className={editingApproved ? "btn btn-ink" : "btn btn-quiet"}
        onClick={onSave}
        disabled={busy || gates.missingFields.length > 0}
        title={missingFieldsTitle(gates, editingApproved ? "saving" : "save")}
      >
        Save
      </button>
      {editingApproved ? (
        <button className="btn btn-out" onClick={onCancel} disabled={busy}>Cancel</button>
      ) : (
        <>
          <button
            className="btn btn-ink"
            onClick={onApprove}
            disabled={busy || gates.typeMissing || gates.missingFields.length > 0}
            title={
              gates.typeMissing ? "Please fill a document type, eg: PO, Invoice"
                : missingFieldsTitle(gates, "approving")
            }
          >
            Approve
          </button>
          <button className="btn btn-out" onClick={onReject} disabled={busy}>Reject</button>
        </>
      )}
    </>
  );
}

const FIELD_LABELS = {
  po_number: "PO no.", doc_number: "Document no.",
  dc_number: "DC / invoice no.", min_number: "MIN no.",
};

function missingFieldsTitle(gates, action) {
  if (!gates.missingFields.length) return undefined;
  const names = gates.missingFields.map((f) => FIELD_LABELS[f] ?? f).join(", ");
  return `Enter ${names} before ${action}`;
}

/* Every problem this screen knows about, keyed to the field it's actually
   about — HeaderFields renders each one under that field's own input, and
   marks the input itself, rather than stacking banners at the top of the
   modal for a reviewer to map back onto fields by hand. A banner is still
   right for anything that isn't about one field (a bad scan overall, a
   disagreement with another document); anything that *is* belongs here. */
function fieldErrorsFor(gates, header, poNumberOptions) {
  const errors = {
    doc_kind: gates.typeUnset || gates.typeOther
      ? "Please fill a document type, eg: PO, Invoice"
      : null,
  };
  gates.missingFields.forEach((f) => {
    errors[f] = `Enter ${FIELD_LABELS[f] ?? f} before save`;
  });

  // Checked live against what's in the field right now — see lib/gstin.js.
  if (header?.vendor_gstin && gstinChecksumOk(header.vendor_gstin) === false) {
    errors.vendor_gstin = "GSTIN mismatch, please check.";
  } else if (gstinIsSelf(header?.vendor_gstin)) {
    errors.vendor_gstin = "This is B&B's own registration — vendor and buyer look swapped.";
  }
  if (header?.buyer_gstin && gstinChecksumOk(header.buyer_gstin) === false) {
    errors.buyer_gstin = "GSTIN mismatch, please check.";
  }

  // A referenced PO that isn't on file in this project — a typo, or a PO not
  // uploaded yet. Never blocks saving (see PoNumberBanner's own note), so
  // it's phrased as a check rather than a demand.
  const referencesPo = ["INVOICE", "DELIVERY", "INWARD", "PURCHASE_BILL"].includes(header?.doc_kind);
  const poNumber = String(header?.po_number ?? "").trim();
  if (referencesPo && poNumber && !errors.po_number && !poNumberOptions.includes(poNumber)) {
    errors.po_number = "No PO with this number in this project — check it, or upload that PO.";
  }

  return errors;
}

function Body({
  header, lines, locked, gates, poNumberOptions, dcNumberOptions, minNumberOptions, materials, lineIssues,
  rejecting, reason, setReason, err, busy, onHeader, onLine, onDecide,
}) {
  if (!header) return <div className="empty">Loading…</div>;

  return (
    <>
      <HeaderFields
        header={header}
        locked={locked}
        onChange={onHeader}
        fieldErrors={locked ? {} : fieldErrorsFor(gates, header, poNumberOptions)}
        fieldOptions={{ po_number: poNumberOptions, dc_number: dcNumberOptions, min_number: minNumberOptions }}
      />
      <LineItems
        lines={lines ?? []}
        materials={materials}
        locked={locked}
        onChange={onLine}
        header={header}
        lineIssues={lineIssues}
      />

      {locked ? null : (
        <div className="field-section">
          <h3>Decision</h3>

          {rejecting ? (
            <div className="reject-panel">
              <textarea
                placeholder="Why is this being rejected?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              {/* Signal orange: the irreversible half of the decision. */}
              <button
                className="btn btn-signal"
                style={{ width: "fit-content" }}
                onClick={() => onDecide("reject")}
                disabled={busy}
              >
                Confirm reject
              </button>
            </div>
          ) : null}

          {err ? <div className="banner banner-err" style={{ marginTop: 16 }}>{err}</div> : null}
        </div>
      )}
    </>
  );
}
