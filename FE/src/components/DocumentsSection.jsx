import { useMemo, useState } from "react";
import { FilterBar } from "./FilterBar.jsx";
import { Modal } from "./Modal.jsx";
import { StatusPill, TypePill } from "./Pills.jsx";
import { IconArrow, IconFile } from "./Icons.jsx";
import { api } from "../lib/api.js";
import { IMAGE_RE, isDraft, isWaiting, matchesFilter, money, refOf, shortDate } from "../lib/format.js";

/* The same register row + filter bar the overall Document Register uses
   (DocumentsTab), reused wherever a scoped list of documents needs the same
   treatment — a project's own Documents tab (every document under any of
   its POs) and a PO's own Documents tab (that PO plus everything referencing
   it: invoice, MIN Voucher, Purchase Bill, anything else). The caller
   decides the scope by which `docs` it passes in; this only filters and
   renders it.

   bulkActions turns on row checkboxes plus a Process/Delete pair on the
   filter bar's own line — opt-in, since the Document Register's read-only
   table has no `reload` to hand back and no business doing either action
   across every project at once. */
export function DocumentsSection({
  docs,
  projects = null,
  onOpenDocument,
  emptyLabel = "Nothing here yet.",
  bulkActions = false,
  reload,
  onProcessed,
}) {
  const [filter, setFilter] = useState({ q: "", project: "", type: "", status: "" });
  const [selected, setSelected] = useState(() => new Set());
  const [working, setWorking] = useState(false);
  const [actionErr, setActionErr] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const shown = useMemo(() => docs.filter((d) => matchesFilter(d, filter)), [docs, filter]);
  const scanned = shown.filter((d) => d.source === "SCAN").length;
  const pending = shown.filter(isWaiting).length;

  const selectedDocs = useMemo(
    () => shown.filter((d) => selected.has(d.document_id)),
    [shown, selected]
  );
  const allShownSelected = shown.length > 0 && selectedDocs.length === shown.length;
  // DRAFT is a document the console chose "Draft" for — confirmed, but
  // extraction was never queued. Process only makes sense while every
  // selected row is still sitting in that state.
  const canProcess = selectedDocs.length > 0 && selectedDocs.every(isDraft);
  const canDelete = selectedDocs.length > 0;

  const toggleOne = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      const shownIds = shown.map((d) => d.document_id);
      if (allShownSelected) shownIds.forEach((id) => next.delete(id));
      else shownIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const runProcess = async () => {
    const ids = selectedDocs.map((d) => d.document_id);
    setWorking(true);
    setActionErr("");
    try {
      await api.processDocuments(ids);
      setSelected(new Set());
      await reload?.();
      // Same "Documents extracted" summary a fresh scan/upload batch opens
      // into (see BatchSummaryModal) — these documents just got queued for
      // extraction the same way, so they wait on the same screen.
      onProcessed?.(ids);
    } catch (e) {
      setActionErr(`Could not process — ${e.message}`);
    } finally {
      setWorking(false);
    }
  };

  const runDelete = async () => {
    setWorking(true);
    setActionErr("");
    try {
      await Promise.all(selectedDocs.map((d) => api.deleteDocument(d.document_id)));
      setSelected(new Set());
      setConfirmingDelete(false);
      await reload?.();
    } catch (e) {
      setActionErr(`Could not delete — ${e.message}`);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="section">
      <FilterBar
        value={filter}
        onChange={setFilter}
        projects={projects}
        actions={bulkActions ? (
          <>
            <button
              className="btn btn-ink btn-sm"
              type="button"
              onClick={runProcess}
              disabled={!canProcess || working}
              title="Only available while every selected document is still a draft"
            >
              Process
            </button>
            <button
              className="btn btn-signal btn-sm"
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={!canDelete || working}
            >
              Delete
            </button>
          </>
        ) : null}
      />

      {actionErr ? <div className="banner banner-err">{actionErr}</div> : null}

      {confirmingDelete ? (
        <Modal
          title="Delete documents"
          subtitle={`${selectedDocs.length} document${selectedDocs.length === 1 ? "" : "s"} selected`}
          closable={!working}
          onClose={() => setConfirmingDelete(false)}
          footer={
            <>
              <div className="spacer" />
              <button
                className="btn btn-out"
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={working}
              >
                Cancel
              </button>
              <button className="btn btn-signal" type="button" onClick={runDelete} disabled={working}>
                {working ? "Deleting…" : "Delete"}
              </button>
            </>
          }
        >
          <p>
            Delete {selectedDocs.length} document{selectedDocs.length === 1 ? "" : "s"}? This can't
            be undone.
          </p>
        </Modal>
      ) : null}

      <div className="section-head">
        <span className="tag">{shown.length} of {docs.length}</span>
        {scanned ? <span className="tag">{scanned} by phone</span> : null}
        {pending ? <span className="tag">{pending} still reading</span> : null}
      </div>

      <div className="card">
        <div className={`dgrid reg${bulkActions ? " selectable" : ""}`}>
          <div className="dhead">
            {bulkActions ? (
              <span className="c-check">
                <input
                  type="checkbox"
                  checked={allShownSelected}
                  onChange={toggleAll}
                  aria-label="Select all shown documents"
                />
              </span>
            ) : null}
            <span />
            <span>Document</span>
            <span>Status</span>
            <span>Vendor</span>
            <span>Project</span>
            <span>Reference</span>
            <span className="r">Amount</span>
            <span>Type</span>
            <span>Captured</span>
            <span />
          </div>

          {shown.length ? shown.map((d) => {
            const file = d.file_paths?.[0];
            const isImage = file && IMAGE_RE.test(file);
            return (
              <div
                key={d.document_id}
                className="drow"
                role="button"
                tabIndex={0}
                onClick={() => onOpenDocument(d.document_id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenDocument(d.document_id);
                  }
                }}
                aria-label={`Review ${d.document_id}`}
              >
                {bulkActions ? (
                  <span className="c-check" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(d.document_id)}
                      onChange={() => toggleOne(d.document_id)}
                      aria-label={`Select ${d.document_id}`}
                    />
                  </span>
                ) : null}
                <span className="c-thumb">
                  {isImage
                    ? <img src={`/${file}`} alt="" loading="lazy" />
                    : <IconFile width={18} height={18} />}
                </span>

                <span className="c-id">{d.document_id.slice(0, 8)}</span>
                <span><StatusPill status={d.status} /></span>
                <span className="c-vend">{d.vendor_name ?? "—"}</span>
                <span className="c-proj">{d.project_code ?? "—"}</span>
                <span className="c-ref">{refOf(d) ?? "—"}</span>
                {money(d.total_value)
                  ? <span className="c-amt">{money(d.total_value)}</span>
                  : <span className="c-amt pending">{isWaiting(d) ? "reading…" : "—"}</span>}
                <span><TypePill type={d.document_type} /></span>
                <span className="c-date">
                  {d.source === "SCAN" ? "Scanned" : "Uploaded"} {shortDate(d.uploaded_at)}
                </span>
                <span className="open-sm" aria-hidden="true">
                  <IconArrow width={18} height={18} />
                </span>
              </div>
            );
          }) : (
            <div className="empty">
              {docs.length ? "No document matches these filters." : emptyLabel}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
