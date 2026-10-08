import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusPill, TypePill } from "../../components/Pills.jsx";
import {
  IconAlertTriangle, IconArrow, IconBack, IconCheck, IconChevron, IconClock, IconClose,
  IconEdit, IconExternalLink, IconTrash, IconTruck, IconZoomIn, IconZoomOut,
} from "../../components/Icons.jsx";
import { AddDocumentMenu } from "../../components/AddDocumentMenu.jsx";
import { DocumentsSection } from "../../components/DocumentsSection.jsx";
import { Modal } from "../../components/Modal.jsx";
import { ArithmeticBanner } from "../../features/review/ReviewModal.jsx";
import { HeaderFields } from "../../features/review/HeaderFields.jsx";
import { LineItems } from "../../features/review/LineItems.jsx";
import { HEADER_KEYS, LINE_FIELDS } from "../../features/review/schema.js";
import { api } from "../../lib/api.js";
import { go } from "../../lib/useHashRoute.js";
import { docTypeLabel, eventTime, isLocked, isWaiting, longDate, money, qty, shortDate } from "../../lib/format.js";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;

/* The scanned page(s) this document was read from — page nav only shows up
   once there's more than one to page through, and zoom is a plain CSS scale
   on the image, not a real viewer, since these are single flat images, not
   a PDF with its own internal structure to navigate. */
function DocumentPreview({ filePaths }) {
  const [pageIdx, setPageIdx] = useState(0);
  const [zoom, setZoom] = useState(1);
  const path = filePaths[Math.min(pageIdx, filePaths.length - 1)];

  return (
    <div className="card doc-preview">
      <div className="doc-preview-head">
        <div>
          <h3>Document Preview</h3>
          <span className="aside-card-sub">Extracted purchase order</span>
        </div>
        <div className="spacer" />
        {path ? (
          <a className="btn btn-quiet btn-xs" href={`/${path}`} target="_blank" rel="noopener noreferrer">
            <IconExternalLink width={14} height={14} />
            Open in new tab
          </a>
        ) : null}
      </div>

      {path ? (
        <>
          <div className="doc-preview-frame">
            <img src={`/${path}`} alt="scanned document page" style={{ transform: `scale(${zoom})` }} />
          </div>
          <div className="doc-preview-controls">
            <button
              type="button"
              className="doc-preview-nav prev"
              disabled={pageIdx === 0}
              onClick={() => setPageIdx((i) => i - 1)}
              aria-label="Previous page"
            >
              <IconChevron width={16} height={16} />
            </button>
            <span className="doc-preview-page">{pageIdx + 1} / {filePaths.length}</span>
            <button
              type="button"
              className="doc-preview-nav"
              disabled={pageIdx === filePaths.length - 1}
              onClick={() => setPageIdx((i) => i + 1)}
              aria-label="Next page"
            >
              <IconChevron width={16} height={16} />
            </button>
            <div className="spacer" />
            <button
              type="button"
              className="doc-preview-nav"
              disabled={zoom <= ZOOM_MIN}
              onClick={() => setZoom((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))}
              aria-label="Zoom out"
            >
              <IconZoomOut width={16} height={16} />
            </button>
            <button
              type="button"
              className="doc-preview-nav"
              disabled={zoom >= ZOOM_MAX}
              onClick={() => setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))}
              aria-label="Zoom in"
            >
              <IconZoomIn width={16} height={16} />
            </button>
          </div>
        </>
      ) : (
        <div className="empty-mini" style={{ padding: "var(--s3)" }}>No scanned page for this document.</div>
      )}
    </div>
  );
}

// What sits on the line in place of an icon — same small dot for every
// kind of event; what happened is in the text, not the marker's colour.
function EventLine({ ev }) {
  return (
    <li>
      <span className="timeline-event-dot" />
      {ev.text} — <span className="timeline-event-time">{eventTime(ev.at)}</span>
    </li>
  );
}

/* The PO document's own history — captured, approved/rejected, and edited
   (the pencil-edit toggle lets an approved PO be corrected same as any
   other document) — same event vocabulary and dot-and-line rail as a
   delivery's own history in the Delivery info tab's Delivery Timeline, just
   for one document instead of a whole group of them, so there's no
   collapse/expand or "next delivery" concept needed here. */
function DocumentTimeline({ doc }) {
  const events = useMemo(() => {
    const label = docTypeLabel(doc.document_type);
    const list = [];
    if (doc.uploaded_at) list.push({ at: doc.uploaded_at, kind: "captured", text: `${label} captured` });
    if (doc.status === "APPROVED" && doc.header?.reviewed_at) {
      list.push({
        at: doc.header.reviewed_at, kind: "approved",
        text: `${label} approved by ${doc.header.reviewed_by ?? "—"}`,
      });
    } else if (doc.status === "REJECTED" && doc.header?.reviewed_at) {
      list.push({
        at: doc.header.reviewed_at, kind: "rejected",
        text: `${label} rejected by ${doc.header.reviewed_by ?? "—"}`
          + (doc.header.rejection_reason ? ` — ${doc.header.rejection_reason}` : ""),
      });
    }
    list.push(...editEvents(doc.header?.edit_history, doc.header?.edited_by, doc.header?.edited_at, label));
    return list.sort((a, b) => toMs(a.at) - toMs(b.at));
  }, [doc]);

  if (!events.length) return null;

  return (
    <div className="card compare-links delivery-timeline">
      <div className="aside-card-head">
        <span className="aside-card-icon"><IconClock width={18} height={18} /></span>
        <h3>Document Timeline</h3>
      </div>
      <ul className="timeline-events timeline-events-standalone">
        {events.map((ev, i) => <EventLine key={i} ev={ev} />)}
      </ul>
    </div>
  );
}

const blank = (v) => (typeof v === "string" && v.trim() === "" ? null : v === "" ? null : v);

/* What gets PUT — same shape ReviewModal saves, kept identical so a PO's
   edits behave exactly like every other document's. */
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

/* This PO's own materials against what's actually turned up across its
   deliveries — same Material/Unit/Ordered/Delivered shape as the project's
   own Materials rollup (MaterialsRollup.jsx), just scoped to one PO's lines
   and fed by the server-computed reconciliation instead of a client-side sum
   across every INVOICE in the project (which would double-count an invoice
   uploaded twice — the reconciliation endpoint already dedupes that per
   delivery group). */
function PoMaterialsSection({ materials, loading, onOpenDocument }) {
  const [open, setOpen] = useState(() => new Set());

  if (loading) {
    return <div className="card"><div className="empty">Reading line items…</div></div>;
  }
  if (!materials?.length) {
    return (
      <div className="card">
        <div className="empty">No materials on this PO yet — they appear once it's been read.</div>
      </div>
    );
  }

  const deliveredClass = (m) => {
    if (!m.ordered_qty) return "";
    if (m.delivered_qty >= m.ordered_qty) return "ok";
    if (m.delivered_qty > 0) return "warn";
    return "mute";
  };

  const toggle = (key) => setOpen((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  return (
    <div className="card">
      <div className={`table-wrap rollup-wrap ${materials.length > 12 ? "is-tall" : ""}`}>
        <table className="data rollup">
          <colgroup>
            <col />
            <col style={{ width: "11ch" }} />
            <col style={{ width: "13ch" }} />
            <col style={{ width: "13ch" }} />
            <col style={{ width: "13ch" }} />
            <col style={{ width: "13ch" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Material</th>
              <th>Unit</th>
              <th className="right">Ordered</th>
              <th className="right">Delivered</th>
              <th className="right">Pending</th>
              <th className="right">Remaining</th>
            </tr>
          </thead>
          <tbody>
            {materials.map((m) => {
              const isOpen = open.has(m.material_id);
              return (
                <Fragment key={m.material_id}>
                  <tr>
                    <td className="c-mat" title={m.material_name}>
                      <div className="rollup-mat-cell">
                        <button
                          className={`rollup-toggle ${isOpen ? "is-open" : ""}`}
                          type="button"
                          onClick={() => toggle(m.material_id)}
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? "Hide" : "Show"} order and delivery breakdown for ${m.material_name ?? "this material"}`}
                        >
                          <IconChevron width={16} height={16} />
                        </button>
                        <span>{m.material_name ?? "Unrecognised material"}</span>
                      </div>
                    </td>
                    <td className="c-unit">{m.unit ?? "—"}</td>
                    <td className="num strong">{m.ordered_qty ? qty(m.ordered_qty) : "—"}</td>
                    <td className={`num strong ${deliveredClass(m)}`}>
                      {m.delivered_qty ? qty(m.delivered_qty) : "—"}
                      {m.over_delivered ? " ⚠" : ""}
                    </td>
                    {/* Claimed by a delivery whose Invoice, MIN Voucher and
                        Purchase Bill haven't all agreed yet — not counted
                        above, not silently dropped either. */}
                    <td className="num mute">{m.pending_qty ? qty(m.pending_qty) : "—"}</td>
                    <td className={`num strong ${m.remaining_qty < 0 ? "is-over" : ""}`}>
                      {qty(Math.abs(m.remaining_qty))}{m.remaining_qty < 0 ? " over" : ""}
                    </td>
                  </tr>

                  {isOpen ? (
                    <tr className="rollup-detail">
                      <td colSpan={6}>
                        <div className="rollup-breakdown">
                          <div>
                            <h4>Purchase order</h4>
                            {m.po_entries?.length ? (
                              <ul>
                                {m.po_entries.map((e, i) => (
                                  <li key={i}>
                                    <span>{e.doc_number}</span>
                                    <span className="qty">{qty(e.quantity)} {m.unit}</span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <div className="empty-mini">Not on this PO — delivered against it anyway.</div>
                            )}
                          </div>
                          <div>
                            <h4>Deliveries</h4>
                            {m.invoice_entries?.length ? (
                              <ul>
                                {m.invoice_entries.map((e, i) => (
                                  <li key={i}>
                                    <button
                                      type="button"
                                      className="link-btn"
                                      onClick={() => onOpenDocument?.(e.document_id)}
                                    >
                                      {e.doc_number}{e.vendor_name ? ` — ${e.vendor_name}` : ""}
                                    </button>
                                    <span className="qty">
                                      {qty(e.quantity)} {m.unit}
                                      {e.status !== "verified" ? " · pending" : ""}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <div className="empty-mini">No delivery has claimed this material yet.</div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* The three-way match's verdict, worn right on the delivery row — verified
   is deliberately shown too, not just the problem states, since it's what
   actually makes a delivery's quantity count toward the PO (see
   po_reconciliation's docstring in main.py). */
function VerificationPill({ status }) {
  if (status === "verified") return <span className="pill s-approved" title="Verified">Verified</span>;
  if (status === "mismatch") return <span className="pill s-rejected" title="Mismatch">Mismatch</span>;
  return <span className="pill s-pending" title="Awaiting verification">Awaiting verification</span>;
}

/* One delivery's diff line between two named documents — labelA/labelB are
   "Invoice", "MIN Voucher" or "Purchase Bill".

   The part that says *what is wrong* is marked, so the eye lands on it
   without reading the whole sentence: which document a material is missing
   from, or — when both have it — the two quantities that disagree.

   A rate of zero is not a price of nothing, it's a document with no rate
   column at all (a MIN Voucher never carries one, and aggregate_by_material
   reports the absence as 0.0) — so it's left out rather than printed as
   "@ ₹0.00", which reads as a price dispute where there is none. */
function DiffLine({ line, labelA, labelB }) {
  const name = line.material_name ?? "Unrecognised material";
  const at = (rate) => (rate ? ` @ ${money(rate)}` : "");

  if (line.qty_a == null) {
    return (
      <>
        {name} — <b className="issue-where">not on {labelA}</b>
        {" "}({labelB} has {qty(line.qty_b)}{at(line.rate_b)})
      </>
    );
  }
  if (line.qty_b == null) {
    return (
      <>
        {name} — <b className="issue-where">not on {labelB}</b>
        {" "}({labelA} has {qty(line.qty_a)}{at(line.rate_a)})
      </>
    );
  }
  return (
    <>
      {name} — {labelA}: <b className="issue-where">{qty(line.qty_a)}</b>{at(line.rate_a)},{" "}
      {labelB}: <b className="issue-where">{qty(line.qty_b)}</b>{at(line.rate_b)}
    </>
  );
}

/* The PO's own headline numbers, at a glance, above the delivery-by-
   delivery detail below it — vendor and PO number so this card still makes
   sense on its own if it's ever scrolled to separately from the phead above
   it, then what the PO is worth against what has actually, verifiedly,
   arrived. */
function DeliverySummary({ po, deliveries, deliveredValue, status }) {
  const statusLabel = status === "verified" ? "Verified" : status === "mismatch" ? "Mismatch" : "In progress";
  const statusClass = status === "verified" ? "s-approved" : status === "mismatch" ? "s-rejected" : "s-pending";

  return (
    <div className="card compare-links delivery-summary">
      <div className="aside-card-head">
        <span className="aside-card-icon"><IconTruck width={18} height={18} /></span>
        <div>
          <h3>Delivery Summary</h3>
          <span className="aside-card-sub">
            {deliveries.length} deliver{deliveries.length === 1 ? "y" : "ies"} captured against this purchase order.
          </span>
        </div>
      </div>
      <dl className="kv-list">
        <div><dt>Vendor</dt><dd>{po.vendor_name ?? "—"}</dd></div>
        <div><dt>PO Number</dt><dd>{po.doc_number ?? "—"}</dd></div>
        <div><dt>Total PO Value</dt><dd>{money(po.total_value) ?? "—"}</dd></div>
        <div><dt>Delivered Value</dt><dd>{money(deliveredValue) ?? "—"}</dd></div>
        <div>
          <dt>Delivery Status</dt>
          <dd>{status ? <span className={`pill ${statusClass}`} title={statusLabel}>{statusLabel}</span> : "—"}</dd>
        </div>
      </dl>
    </div>
  );
}

// uploaded_at ("2026-09-26 11:51:27") and reviewed_at/edited_at/deleted_at
// ("2026-09-26T11:51:39+00:00") come back in two different shapes — this is
// the one place both get compared against each other, so it parses either
// into a real instant rather than relying on either's own raw string order.
// uploaded_at is genuinely UTC (SQLite's own datetime('now')) but carries no
// offset, so it's forced to +00:00 explicitly here — left as-is, a browser
// not itself on UTC parses it as *local* time instead, shifting every
// "captured" event by the viewer's own UTC offset relative to every
// reviewed_at/edited_at/deleted_at (which already says +00:00), and it was
// exactly that shift burying a document's own "captured" line away from its
// "approved" one even when the two were seconds apart.
const toMs = (stamp) => {
  const s = String(stamp).replace(" ", "T");
  return new Date(/[+-]\d\d:\d\d$|Z$/.test(s) ? s : `${s}+00:00`).getTime();
};

/* One "edited" event per actual edit (see document_edits in db.py), not
   one whose timestamp just kept moving every time the same approved
   document was corrected again. Falls back to the single edited_by/
   edited_at pair doc_headers still carries for a document edited before
   that table existed, so its one known edit doesn't just vanish. */
function editEvents(history, fallbackBy, fallbackAt, label) {
  const list = history?.length ? history
    : (fallbackBy && fallbackAt ? [{ edited_by: fallbackBy, edited_at: fallbackAt }] : []);
  return list.map((e) => ({ at: e.edited_at, kind: "edited", text: `${label} edited by ${e.edited_by}` }));
}

/* One entry per delivery, oldest first — "Next delivery" (below) reads
   naturally as moving forward in time from the one before it, and only runs
   out once every real delivery has had its turn.

   Each entry is its own document's worth of history, not one summary
   sentence: captured (uploaded), approved or rejected, and — since the
   pencil-edit toggle lets an approved document be corrected — edited,
   across every document the delivery is made of (Invoice, MIN Voucher,
   Purchase Bill, and a real Delivery challan when one exists). Sorted
   chronologically so the sequence of events reads the way it happened, not
   grouped by which document produced it.

   The first delivery's own history starts open — openKeys is which
   deliveries' history is currently showing, independent of one another:
   opening one doesn't close any other that's already open, only its own
   title click does that. */
function DeliveryTimeline({ deliveries, maxHeightPx }) {
  const entries = useMemo(() => {
    return deliveries
      .map((d) => {
        const events = [];
        // deleted_documents is folded in here only — a document already
        // deleted has nothing left to open, so it stays out of d.documents
        // itself, which the Delivery info list below still renders as
        // clickable rows (see po_reconciliation in main.py).
        [...d.documents, ...(d.deleted_documents ?? [])].forEach((doc) => {
          const label = docTypeLabel(doc.document_type);
          if (doc.uploaded_at) events.push({ at: doc.uploaded_at, kind: "captured", text: `${label} captured` });
          if (doc.status === "APPROVED" && doc.reviewed_at) {
            events.push({
              at: doc.reviewed_at, kind: "approved",
              text: `${label} approved by ${doc.reviewed_by ?? "—"}`,
            });
          } else if (doc.status === "REJECTED" && doc.reviewed_at) {
            events.push({
              at: doc.reviewed_at, kind: "rejected",
              text: `${label} rejected by ${doc.reviewed_by ?? "—"}`
                + (doc.rejection_reason ? ` — ${doc.rejection_reason}` : ""),
            });
          }
          events.push(...editEvents(doc.edit_history, doc.edited_by, doc.edited_at, label));
          if (doc.deleted_at) {
            events.push({ at: doc.deleted_at, kind: "deleted", text: `${label} deleted` });
          }
        });
        // Sorted by actual instant, not by the raw string — uploaded_at
        // comes back as "2026-09-26 11:51:27" (a space) while reviewed_at/
        // edited_at/deleted_at are ISO ("...T11:51:39+00:00"), and a plain
        // string compare puts every space-formatted timestamp before every
        // T-formatted one regardless of which actually happened first —
        // which used to bury a document's own "captured" line away from
        // its "approved"/"edited"/"deleted" line even when they were
        // seconds apart.
        events.sort((a, b) => toMs(a.at) - toMs(b.at));
        return {
          key: d.doc_number, docNumber: d.doc_number,
          date: events[0]?.at, events, status: d.verification.status,
        };
      })
      .filter((e) => e.date)
      .sort((a, b) => toMs(a.date) - toMs(b.date));
  }, [deliveries]);

  const [openKeys, setOpenKeys] = useState(() => new Set(entries[0] ? [entries[0].key] : []));
  const toggleOpen = (key) => setOpenKeys((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  return (
    <div className="card compare-links delivery-timeline">
      <div className="aside-card-head">
        <span className="aside-card-icon"><IconClock width={18} height={18} /></span>
        <h3>Delivery Timeline</h3>
      </div>
      <ul className="timeline" style={{ maxHeight: `${maxHeightPx || 600}px` }}>
        {entries.map((e) => {
          const isOpen = openKeys.has(e.key);
          // Collapsed, only the most recent few show — oldest to newest,
          // same order as the full list — with a hint below them to expand
          // for whatever's earlier. Open, the full history's there instead.
          const shown = e.events.slice(-5);
          const earlierCount = e.events.length - shown.length;
          return (
            <li key={e.key}>
              <span className={`timeline-dot ${e.status === "verified" ? "d-ok" : e.status === "mismatch" ? "d-no" : "d-ink"}`} />
              <div
                className="timeline-entry"
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                onClick={() => toggleOpen(e.key)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    toggleOpen(e.key);
                  }
                }}
              >
                <span className="timeline-date">
                  {e.docNumber ? `${e.docNumber} · ` : ""}{longDate(e.date)}
                </span>
                {!isOpen && earlierCount > 0 ? (
                  <div className="timeline-more">Click to see {earlierCount} previous</div>
                ) : null}
                <ul className="timeline-events">
                  {(isOpen ? e.events : shown).map((ev, j) => <EventLine key={j} ev={ev} />)}
                </ul>
              </div>
            </li>
          );
        })}
        <li className="is-future">
          <span className="timeline-dot d-mute" />
          <div>
            <div className="timeline-date">Next delivery</div>
            <div className="timeline-desc">No further deliveries yet.</div>
          </div>
        </li>
      </ul>
    </div>
  );
}

/* Same slot the PO tab uses for the scanned image — here it's the thing a
   reviewer actually needs while looking at a list of deliveries: which ones
   disagree with themselves. Missing documents and "not verified yet" are
   both shown elsewhere (the delivery's own "Missing documents:" line and
   its Verified/Awaiting verification/Mismatch pill in the list to the
   left) — this panel is only for an actual disagreement: all three of
   Invoice, MIN Voucher and Purchase Bill exist but don't match on material
   or quantity. Each disagreeing pair (invoice vs MIN, invoice vs purchase
   bill, MIN vs purchase bill) gets its own block, named by which two
   documents disagree. */
function DeliveryIssuesPanel({ deliveries, loading, onOpenDocument }) {
  if (loading) {
    return <div className="card compare-links"><div className="empty-mini">Loading…</div></div>;
  }

  const flagged = (deliveries ?? []).filter((d) => d.verification.status === "mismatch");

  return (
    <div className="card compare-links">
      <div className="aside-card-head">
        <span className="aside-card-icon aside-card-icon-warn"><IconAlertTriangle width={18} height={18} /></span>
        <h3>Issues</h3>
      </div>
      {!flagged.length ? (
        <div className="empty-mini">
          {deliveries?.length
            ? "No mismatches — every Invoice, MIN Voucher and Purchase Bill checked so far agree."
            : "Nothing to check yet."}
        </div>
      ) : (
        flagged.map((delivery) => {
          const v = delivery.verification;
          // Purchase Bill is optional (see po_reconciliation) — v.diffs only
          // carries the two purchase-bill pairs when one actually exists.
          const pairs = [
            ["invoice_vs_min", "Invoice", "MIN Voucher", v.invoice_document_id, v.inward_document_id],
            ["invoice_vs_purchase_bill", "Invoice", "Purchase Bill", v.invoice_document_id, v.purchase_bill_document_id],
            ["min_vs_purchase_bill", "MIN Voucher", "Purchase Bill", v.inward_document_id, v.purchase_bill_document_id],
          ].filter(([key]) => v.diffs[key] && !v.diffs[key].clean);

          return (
            <div key={delivery.doc_number} className="delivery-issue">
              <div className="delivery-issue-head">
                <span className="compare-link-num">{delivery.doc_number}</span>
                <span className="compare-link-meta">{delivery.vendor_name ?? "Vendor not read"}</span>
              </div>
              {pairs.map(([key, labelA, labelB, idA, idB]) => {
                const diff = v.diffs[key];
                const badLines = (diff.lines ?? []).filter((l) => !l.match);
                return (
                  <div key={key}>
                    <p className="delivery-issue-lead">
                      <button type="button" className="link-btn" onClick={() => onOpenDocument(idA)}>
                        {labelA}
                      </button>
                      {" and "}
                      <button type="button" className="link-btn" onClick={() => onOpenDocument(idB)}>
                        {labelB}
                      </button>
                      {" disagree:"}
                    </p>
                    <ul className="delivery-issue-lines">
                      {badLines.map((l) => (
                        <li key={l.material_id}>
                          <DiffLine line={l} labelA={labelA} labelB={labelB} />
                        </li>
                      ))}
                      {(diff.unmatched_a ?? []).map((l, i) => (
                        <li key={`ua-${i}`}>Unrecognised line on {labelA} — "{l.description_raw}"</li>
                      ))}
                      {(diff.unmatched_b ?? []).map((l, i) => (
                        <li key={`ub-${i}`}>Unrecognised line on {labelB} — "{l.description_raw}"</li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          );
        })
      )}
    </div>
  );
}

/* The PO is why this page was opened — it keeps the full width and its full
   edit/approve/reject workflow. The scanned page and whatever invoices
   already carry its number are supporting material, not equal billing: a
   narrow sidebar, not a second full column. An invoice is a link through to
   its own full review, not reproduced here — a summary line is what's needed
   to recognise it, not its whole line-item table a second time.

   The reconciliation itself — materials/qty delivered-so-far against what
   was ordered, and each delivery's Invoice/MIN Voucher/Purchase Bill
   cross-check — comes from GET .../reconciliation (see main.py), computed
   server-side against the same po_number == this PO's own doc_number match
   this page always used; `matches` below is only the fallback while that
   call is still loading. */
export function ComparePage({
  documentId, docs, materials, onOpenDocument, onOpenGenerated, reload, onAddDocument, onScan,
}) {
  const [section, setSection] = useState("po");
  const [po, setPo] = useState(null);
  const [draft, setDraft] = useState(null);
  const [recon, setRecon] = useState(null);
  const [reviewer, setReviewer] = useState(() => localStorage.getItem("reviewerName") ?? "");
  const [rejecting, setRejecting] = useState(false);
  /* Reopens an APPROVED PO's form for a correction, without moving it back
     to EXTRACTED — same pencil-edit toggle as ReviewModal's, on the PO tab
     here instead of in a popup. Only ever true while po.status is still
     APPROVED. */
  const [editingApproved, setEditingApproved] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingDeletePo, setConfirmingDeletePo] = useState(false);
  const [deletingPo, setDeletingPo] = useState(false);
  // Which document, or which whole delivery (by its doc_number), is mid
  // delete-confirmation in the Delivery info tab — at most one at a time,
  // so confirming one doesn't leave a stray "are you sure" open elsewhere.
  const [confirmingDeleteDoc, setConfirmingDeleteDoc] = useState(null);
  const [confirmingDeleteDelivery, setConfirmingDeleteDelivery] = useState(null);
  const [deletingKey, setDeletingKey] = useState(null);
  // Which delivery (by its doc_number) is asking the reviewer to pick a
  // source document, because its Invoice and MIN Voucher disagree — see
  // generatePurchaseBillFor below. Null once resolved or cancelled.
  const [pbMismatchFor, setPbMismatchFor] = useState(null);
  const [generatingPbFor, setGeneratingPbFor] = useState(null);

  // Delivery Timeline's own cap tracks the Delivery info tab's main column
  // instead of sitting at a fixed height regardless of it — past 1200px of
  // that column, the timeline's own max-height grows by the same amount it
  // grew by, so it keeps roughly in step with a tab that's already long
  // rather than looking stunted next to it.
  const deliveryMainRef = useRef(null);
  const [deliveryMainHeight, setDeliveryMainHeight] = useState(0);
  useEffect(() => {
    const el = deliveryMainRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setDeliveryMainHeight(entry.contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, [section]);
  const timelineMaxHeight = 600 + Math.max(0, deliveryMainHeight - 1200);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let watched = false;

    const read = async () => {
      const fresh = await api.getDocument(documentId).catch(() => null);
      if (cancelled || !fresh) return;
      setPo(fresh);
      if (isWaiting(fresh)) { watched = true; timer = setTimeout(read, 3000); }
      else if (watched) reload();
    };

    read();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [documentId, reload]);

  useEffect(() => {
    if (!po || isWaiting(po) || isLocked(po)) return;
    setDraft((prev) => prev ?? {
      header: { ...(po.header ?? {}) },
      lines: (po.lines ?? []).map((l) => ({ ...l })),
    });
  }, [po]);

  const reloadRecon = useCallback(async () => {
    const fresh = await api.getPoReconciliation(documentId).catch(() => null);
    setRecon(fresh);
  }, [documentId]);

  /* Only meaningful once the PO itself has actually been read — reruns
     whenever docs changes (an invoice being uploaded, extracted, or edited
     all move that list), so a newly-matched invoice shows up without
     needing its own poll loop. */
  useEffect(() => {
    if (!po || isWaiting(po)) return;
    reloadRecon();
  }, [po, docs, reloadRecon]);

  const setHeader = (key, value) => setDraft((d) => ({ ...d, header: { ...d.header, [key]: value } }));
  const setLine = (lineNo, key, value) =>
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l) => (l.line_no === lineNo ? { ...l, [key]: value } : l)),
    }));

  const save = useCallback(async ({ silent = false, extra = {} } = {}) => {
    setErr("");
    try {
      const updated = await api.saveDocument(documentId, { ...buildEdits(draft), ...extra });
      if (!silent) { setPo(updated); reload(); }
      return updated;
    } catch (e) {
      setErr(`Could not save — ${e.message}`);
      return null;
    }
  }, [documentId, draft, reload]);

  /* Pencil at the top of the PO tab — snapshots the PO's current
     (already-approved) values into draft, same as ReviewModal's version. */
  const beginEditApproved = () => {
    setErr("");
    setDraft({
      header: { ...(po.header ?? {}) },
      lines: (po.lines ?? []).map((l) => ({ ...l })),
    });
    setEditingApproved(true);
  };

  /* Same "enter your name first" gate Approve has always had here — see
     decide() below — applied to this Save instead. Records the name onto
     edited_by/edited_at server-side (reviewed_by/reviewed_at, the original
     approval, is left untouched) and drops back to the read-only Approved
     view on success. */
  const saveApprovedEdit = async () => {
    const name = reviewer.trim();
    if (!name) { setErr("Enter your name first."); return; }
    localStorage.setItem("reviewerName", name);
    setBusy(true);
    const ok = await save({ extra: { edited_by: name } });
    setBusy(false);
    if (ok) setEditingApproved(false);
  };

  const cancelEditApproved = () => {
    setErr("");
    setEditingApproved(false);
  };

  const decide = async (kind) => {
    const name = reviewer.trim();
    if (!name) { setErr("Enter your name first."); return; }
    if (kind === "reject" && !reason.trim()) { setErr("A rejection reason is required."); return; }
    localStorage.setItem("reviewerName", name);

    setBusy(true);
    if (!(await save({ silent: true }))) { setBusy(false); return; }
    try {
      const updated = kind === "approve"
        ? await api.approveDocument(documentId, name)
        : await api.rejectDocument(documentId, name, reason.trim());
      setPo(updated);
      reload();
    } catch (e) {
      setErr(`Could not ${kind} — ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    await api.retryExtraction(documentId);
    setPo(await api.getDocument(documentId).catch(() => po));
    reload();
  };

  const deletePo = async () => {
    setDeletingPo(true);
    try {
      await api.deleteDocument(documentId);
      reload();
      go(`/project/${po.project_id}`);
    } catch (e) {
      setErr(`Could not delete — ${e.message}`);
      setDeletingPo(false);
    }
  };

  /* One document out of a delivery — a wrong upload, most often. Removing
     it never touches the others in its group; the delivery just goes back
     to missing whichever slot that document filled. */
  const deleteOneDoc = async (docId) => {
    setDeletingKey(docId);
    try {
      await api.deleteDocument(docId);
      setConfirmingDeleteDoc(null);
      await reloadRecon();
      reload();
    } catch (e) {
      setErr(`Could not delete — ${e.message}`);
    } finally {
      setDeletingKey(null);
    }
  };

  /* The whole delivery at once — every document currently grouped under it
     (invoices, challan, inward report alike). */
  const deleteDelivery = async (delivery) => {
    setDeletingKey(delivery.doc_number);
    try {
      await Promise.all(delivery.documents.map((d) => api.deleteDocument(d.document_id)));
      setConfirmingDeleteDelivery(null);
      await reloadRecon();
      reload();
    } catch (e) {
      setErr(`Could not delete — ${e.message}`);
    } finally {
      setDeletingKey(null);
    }
  };

  /* Builds this delivery's Purchase Bill from its Invoice + MIN Voucher.
     Called directly when the two already agree (base doesn't matter then);
     otherwise the caller has already asked which one to build from — see
     the pbMismatchFor popup below. */
  const generatePurchaseBillFor = async (delivery, base) => {
    const { invoice_document_id: invoiceId, inward_document_id: inwardId } = delivery.verification;
    setGeneratingPbFor(delivery.doc_number);
    setErr("");
    try {
      const created = await api.generatePurchaseBill(invoiceId, inwardId, base);
      setPbMismatchFor(null);
      await reloadRecon();
      reload();
      // Not onOpenDocument — this one isn't kept unless the reviewer
      // actually saves/approves/rejects it (see App.jsx's openGenerated).
      onOpenGenerated(created.document_id);
    } catch (e) {
      setErr(`Could not generate Purchase Bill — ${e.message}`);
    } finally {
      setGeneratingPbFor(null);
    }
  };

  const clickGeneratePurchaseBill = (delivery) => {
    const clean = delivery.verification.diffs?.invoice_vs_min?.clean;
    if (clean) {
      generatePurchaseBillFor(delivery, "invoice");
    } else {
      setPbMismatchFor(delivery.doc_number);
    }
  };

  if (!po) {
    return <div className="band"><div className="col"><div className="empty">Loading…</div></div></div>;
  }

  const matches = docs.filter(
    (d) => d.document_type === "INVOICE" && d.project_id === po.project_id
      && d.po_number && d.po_number === po.doc_number
  );

  // Every document this PO's own "Documents" tab shows: the PO itself, plus
  // any Invoice, MIN Voucher, Purchase Bill or anything else that carries
  // this PO's number — the same reference the Delivery info tab and
  // po_reconciliation already thread documents together by.
  const poDocuments = docs.filter(
    (d) => d.document_id === po.document_id
      || (d.project_id === po.project_id && d.po_number && d.po_number === po.doc_number)
  );

  // AddDocumentMenu/UploadModal/ScanModal only ever read id/code/name off
  // this — the PO itself already carries all three of its own project's,
  // so a new invoice, challan or inward report added from here lands in
  // the same project as the PO, same as adding one from the project page.
  const project = { id: po.project_id, code: po.project_code, name: po.project_name };

  // What has actually, verifiedly, arrived — an unverified delivery's
  // claimed value stays out of this, same as its quantities stay out of
  // delivered_qty on the materials tab (see po_reconciliation's docstring).
  const deliveredValue = (recon?.deliveries ?? []).reduce((sum, d) => {
    if (d.verification.status !== "verified") return sum;
    const invoiceDoc = d.documents.find((doc) => doc.document_type === "INVOICE");
    return sum + (Number(invoiceDoc?.total_value) || 0);
  }, 0);
  const deliveryStatus = !recon?.deliveries?.length ? null
    : recon.deliveries.some((d) => d.verification.status === "mismatch") ? "mismatch"
    : recon.deliveries.every((d) => d.verification.status === "verified") ? "verified"
    : "pending";

  const locked = isLocked(po) && !editingApproved;
  const header = locked ? (po.header ?? {}) : draft?.header;
  const lines = locked ? (po.lines ?? []) : draft?.lines;

  return (
    <div className="band">
      <div className="col">
        <div className="phead">
          <button className="back" type="button" onClick={() => go(`/project/${po.project_id}`)}>
            <IconBack width={16} height={16} />
            {po.project_code ?? "Project"}
          </button>

          <div className="phead-main">
            <div>
              <div className="code">{po.doc_number ?? po.document_id.slice(0, 8)}</div>
              <div className="pname">Purchase order — {po.project_name}</div>
            </div>
            <div className="spacer" />
            <div className="phead-actions">
              <StatusPill status={po.status} />
              <AddDocumentMenu
                onScan={() => onScan(project)}
                onUpload={() => onAddDocument(project)}
              />
              <button
                className="icon-btn-danger"
                type="button"
                aria-label="Delete PO"
                title="Delete PO"
                onClick={() => setConfirmingDeletePo(true)}
              >
                <IconTrash width={16} height={16} />
              </button>
            </div>
          </div>

          <div className="phead-meta">
            <span>{po.vendor_name ?? "Vendor not read yet"}</span>
            <span className="sep">·</span>
            <span>{shortDate(po.uploaded_at)}</span>
            {money(po.total_value) ? (
              <>
                <span className="sep">·</span>
                <span><b>{money(po.total_value)}</b></span>
              </>
            ) : null}
          </div>

          {confirmingDeletePo ? (
            <div className="banner banner-err" style={{ marginTop: 16 }}>
              <div>
                Delete this PO ({po.doc_number ?? po.document_id})? This doesn't remove the
                invoices, MIN Vouchers or Purchase Bills referencing it — only the PO document
                itself. This can't be undone.
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button className="btn btn-signal btn-sm" type="button" onClick={deletePo} disabled={deletingPo}>
                  {deletingPo ? "Deleting…" : "Delete PO"}
                </button>
                <button
                  className="btn btn-out btn-sm"
                  type="button"
                  onClick={() => setConfirmingDeletePo(false)}
                  disabled={deletingPo}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="ptabs">
          {[
            { id: "po", label: "PO" },
            { id: "delivery", label: `Delivery info${recon?.deliveries?.length ? ` (${recon.deliveries.length})` : ""}` },
            { id: "documents", label: `Documents (${poDocuments.length})` },
            { id: "materials", label: "Materials" },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={section === t.id}
              onClick={() => setSection(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {section === "po" ? (
        <div className="compare-layout">
          <div className="card compare-main">
            {po.status === "APPROVED" && !editingApproved ? (
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="icon-btn-bare"
                  onClick={beginEditApproved}
                  title="Edit this PO"
                  aria-label="Edit this PO"
                >
                  <IconEdit width={26} height={26} />
                </button>
              </div>
            ) : null}

            {isWaiting(po) ? (
              <div className="banner banner-wait">Extraction in progress… this updates automatically.</div>
            ) : null}

            {po.status === "FAILED" ? (
              <div className="banner banner-err">
                Extraction failed — {po.error || "unknown error"}.
                <div style={{ marginTop: 10 }}>
                  <button className="btn btn-out" onClick={retry}>Retry extraction</button>
                </div>
              </div>
            ) : null}

            {!isWaiting(po) && po.status !== "FAILED" && header ? (
              <>
                <HeaderFields header={header} locked={locked} onChange={setHeader} />
                <ArithmeticBanner header={header} lines={lines} />
                <LineItems lines={lines ?? []} materials={materials} locked={locked} onChange={setLine} header={header} />

                {locked ? (
                  <div className={`banner ${po.status === "APPROVED" ? "banner-ok" : "banner-err"}`} style={{ marginTop: 16 }}>
                    {po.status === "APPROVED"
                      ? `Approved by ${po.header?.reviewed_by} on ${po.header?.reviewed_at}`
                      : `Rejected by ${po.header?.reviewed_by} on ${po.header?.reviewed_at}${po.header?.rejection_reason ? ` — ${po.header.rejection_reason}` : ""}`}
                  </div>
                ) : editingApproved ? (
                  <div className="field-section">
                    <h3>Decision</h3>
                    <div className="reviewer-row">
                      <input
                        className="input"
                        placeholder="Your name"
                        value={reviewer}
                        onChange={(e) => setReviewer(e.target.value)}
                      />
                      <button className="btn btn-ink" onClick={saveApprovedEdit} disabled={busy}>Save</button>
                      <button className="btn btn-out" onClick={cancelEditApproved} disabled={busy}>Cancel</button>
                    </div>

                    {err ? <div className="banner banner-err" style={{ marginTop: 16 }}>{err}</div> : null}
                  </div>
                ) : (
                  <div className="field-section">
                    <h3>Decision</h3>
                    <div className="reviewer-row">
                      <input
                        className="input"
                        placeholder="Your name"
                        value={reviewer}
                        onChange={(e) => setReviewer(e.target.value)}
                      />
                      <button className="btn btn-quiet" onClick={() => save()} disabled={busy}>Save changes</button>
                      <button className="btn btn-ink" onClick={() => decide("approve")} disabled={busy}>Approve</button>
                      <button className="btn btn-out" onClick={() => setRejecting(true)} disabled={busy}>Reject</button>
                    </div>

                    {rejecting ? (
                      <div className="reject-panel">
                        <textarea
                          placeholder="Why is this being rejected?"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                        <button
                          className="btn btn-signal"
                          style={{ width: "fit-content" }}
                          onClick={() => decide("reject")}
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
            ) : null}
          </div>

          <div className="compare-aside">
            <DocumentPreview filePaths={po.file_paths} />
            <DocumentTimeline doc={po} />
          </div>
        </div>
        ) : section === "delivery" ? (
        <div className="compare-layout">
          <div className="card compare-main" ref={deliveryMainRef}>
            <h3 style={{ padding: "var(--s3) var(--s3) 0" }}>
              {recon?.deliveries?.length
                ? `${recon.deliveries.length} deliver${recon.deliveries.length === 1 ? "y" : "ies"}`
                : matches.length ? `Matching invoice${matches.length === 1 ? "" : "s"}` : "Deliveries"}
            </h3>

            {err ? (
              <div className="banner banner-err" style={{ margin: "0 var(--s3) var(--s3)" }}>{err}</div>
            ) : null}

            {recon?.deliveries?.length ? recon.deliveries.map((delivery) => (
              <div key={delivery.doc_number} className="compare-delivery">
                <div className="compare-delivery-head">
                  <span className="compare-link-num">{delivery.doc_number}</span>
                  <span className="compare-link-meta">{delivery.vendor_name ?? "Vendor not read"}</span>
                  <VerificationPill status={delivery.verification.status} />
                  <div className="spacer" />
                  {/* Only once this delivery actually has both source
                      documents to build from, and doesn't have a Purchase
                      Bill of its own yet — see generatePurchaseBillFor.
                      Sits right before the delete icon so that icon stays
                      the row's own rightmost element — lined up with the
                      per-document delete icons directly below it. */}
                  {delivery.verification.invoice_document_id
                    && delivery.verification.inward_document_id
                    && !delivery.verification.purchase_bill_document_id ? (
                    <button
                      type="button"
                      className="btn btn-out btn-xs"
                      onClick={() => clickGeneratePurchaseBill(delivery)}
                      disabled={generatingPbFor === delivery.doc_number}
                    >
                      {generatingPbFor === delivery.doc_number ? "Generating…" : "Generate Purchase Bill"}
                    </button>
                  ) : null}
                  {confirmingDeleteDelivery === delivery.doc_number ? (
                    <span className="row-actions">
                      Delete all {delivery.documents.length}?
                      <button
                        className="row-link go"
                        type="button"
                        title="Confirm"
                        aria-label={`Confirm deleting all ${delivery.documents.length} documents`}
                        onClick={() => deleteDelivery(delivery)}
                        disabled={deletingKey === delivery.doc_number}
                      >
                        {deletingKey === delivery.doc_number ? "…" : <IconCheck width={16} height={16} />}
                      </button>
                      <button
                        className="row-link stop"
                        type="button"
                        title="Cancel"
                        aria-label="Cancel"
                        onClick={() => setConfirmingDeleteDelivery(null)}
                      >
                        <IconClose width={16} height={16} />
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="compare-link-delete"
                      aria-label="Delete this whole delivery"
                      title="Delete every document in this delivery"
                      onClick={() => setConfirmingDeleteDelivery(delivery.doc_number)}
                    >
                      <IconTrash width={15} height={15} />
                    </button>
                  )}
                </div>
                {delivery.missing?.length ? (
                  <div className="compare-missing">
                    Missing documents: {delivery.missing.join(", ")}
                  </div>
                ) : null}
                {pbMismatchFor === delivery.doc_number ? (
                  <Modal
                    glacier
                    maxWidth="620px"
                    title="Generate Purchase Bill"
                    subtitle={delivery.doc_number}
                    closable={generatingPbFor !== delivery.doc_number}
                    onClose={() => setPbMismatchFor(null)}
                    footer={
                      <>
                        <button
                          className="btn btn-quiet"
                          type="button"
                          onClick={() => setPbMismatchFor(null)}
                          disabled={generatingPbFor === delivery.doc_number}
                        >
                          Cancel
                        </button>
                        <div className="spacer" />
                        <button
                          className="btn btn-out"
                          type="button"
                          onClick={() => generatePurchaseBillFor(delivery, "invoice")}
                          disabled={generatingPbFor === delivery.doc_number}
                        >
                          Generate with Invoice
                        </button>
                        <button
                          className="btn btn-ink"
                          type="button"
                          onClick={() => generatePurchaseBillFor(delivery, "min")}
                          disabled={generatingPbFor === delivery.doc_number}
                        >
                          Generate with MIN
                        </button>
                      </>
                    }
                  >
                    <p style={{ margin: 0 }}>
                      There will be a mismatch between Invoice and MIN — pick which one the
                      Purchase Bill should be built from.
                    </p>
                  </Modal>
                ) : null}
                {delivery.documents.map((d) => (
                  <div key={d.document_id} className="compare-link-row">
                    <button
                      type="button"
                      className="compare-link-open"
                      onClick={() => onOpenDocument(d.document_id)}
                    >
                      <div className="compare-link-main">
                        <div className="compare-link-num-row">
                          {/* The document's own number — a MIN Voucher or
                              Purchase Bill carries its own MIN No/PV No, not
                              the invoice number the group above is named
                              after, so this is the one place that actually
                              says so. */}
                          <span className="compare-link-num">{d.doc_number || "Document not yet numbered"}</span>
                          {/* Every document in a delivery is the same vendor
                              by construction (see po_reconciliation's
                              grouping) — repeated per row anyway, since a row
                              reads as its own document, not just a slot in
                              the group above it. */}
                          <span className="compare-link-vendor">{delivery.vendor_name ?? "Vendor not read"}</span>
                        </div>
                        <div className="compare-link-meta">
                          {shortDate(d.uploaded_at)}
                          {money(d.total_value) ? ` · ${money(d.total_value)}` : ""}
                          {d.page_count > 1 ? ` · ${d.page_count} pages` : ""}
                        </div>
                      </div>
                      <TypePill type={d.document_type} />
                      <StatusPill status={d.status} />
                      <IconArrow width={16} height={16} />
                    </button>
                    {confirmingDeleteDoc === d.document_id ? (
                      <span className="row-actions">
                        Delete?
                        <button
                          className="row-link go"
                          type="button"
                          title="Confirm"
                          aria-label="Confirm deleting this document"
                          onClick={() => deleteOneDoc(d.document_id)}
                          disabled={deletingKey === d.document_id}
                        >
                          {deletingKey === d.document_id ? "…" : <IconCheck width={16} height={16} />}
                        </button>
                        <button
                          className="row-link stop"
                          type="button"
                          title="Cancel"
                          aria-label="Cancel"
                          onClick={() => setConfirmingDeleteDoc(null)}
                        >
                          <IconClose width={16} height={16} />
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="compare-link-delete"
                        aria-label="Delete this document"
                        onClick={() => setConfirmingDeleteDoc(d.document_id)}
                      >
                        <IconTrash width={15} height={15} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )) : !recon ? (
              <div className="empty-mini" style={{ padding: "0 var(--s3) var(--s3)" }}>Loading…</div>
            ) : (
              <div className="empty-mini" style={{ padding: "0 var(--s3) var(--s3)" }}>
                No invoice or delivery note yet references PO {po.doc_number ?? "this document"} — once
                one is scanned and read, it will show up here automatically.
              </div>
            )}
          </div>

          <div className="compare-aside">
            <DeliveryIssuesPanel deliveries={recon?.deliveries} loading={!recon} onOpenDocument={onOpenDocument} />
            {recon ? (
              <>
                <DeliverySummary po={po} deliveries={recon.deliveries} deliveredValue={deliveredValue} status={deliveryStatus} />
                {recon.deliveries.length ? (
                  <DeliveryTimeline deliveries={recon.deliveries} maxHeightPx={timelineMaxHeight} />
                ) : null}
              </>
            ) : null}
          </div>
        </div>
        ) : section === "documents" ? (
        <DocumentsSection
          docs={poDocuments}
          onOpenDocument={onOpenDocument}
          emptyLabel="No documents linked to this PO yet."
        />
        ) : (
        <PoMaterialsSection materials={recon?.materials} loading={!recon} onOpenDocument={onOpenDocument} />
        )}
      </div>
    </div>
  );
}
