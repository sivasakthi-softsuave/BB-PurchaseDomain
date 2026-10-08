import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal.jsx";
import { api } from "../../lib/api.js";
import { docTypeLabel, isWaiting, statusClass } from "../../lib/format.js";

/* Shown once, right after an upload, before the per-document Review flow
   starts — waits for every document the upload produced to finish
   extracting, then lists what each one turned out to be. Nothing here
   saves or approves anything, and nothing opens the Review screen on top of
   it either — a row's thumbnail is a plain link to the scanned page, same as
   every page thumbnail elsewhere in the app, opening in its own tab rather
   than stacking a second modal on this one. Next hands the same id list to
   the existing review queue (see App.jsx's openReviewQueue). */
export function BatchSummaryModal({ ids, onNext, onClose }) {
  const [items, setItems] = useState(() => ids.map((id) => ({ document_id: id, status: "PENDING" })));

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const read = async () => {
      const fresh = await Promise.all(ids.map((id) => api.getDocument(id).catch(() => null)));
      if (cancelled) return;
      setItems(fresh.map((d, i) => d ?? { document_id: ids[i], status: "FAILED", error: "Could not load" }));
      if (fresh.some((d) => d && isWaiting(d))) timer = setTimeout(read, 3000);
    };

    read();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [ids]);

  const stillWaiting = items.some((d) => isWaiting(d));
  const doneCount = items.filter((d) => !isWaiting(d)).length;

  return (
    <Modal
      title="Documents extracted"
      subtitle={
        stillWaiting
          ? `Reading ${doneCount}/${items.length}…`
          : `${items.length} document${items.length === 1 ? "" : "s"} ready for review`
      }
      wide
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-ink" onClick={onNext} disabled={stillWaiting}>
            Next
          </button>
        </>
      }
    >
      <ul className="batch-list">
        {items.map((d) => {
          const file = d.file_paths?.[0];
          const label = isWaiting(d) ? "Reading…" : d.status === "FAILED" ? "Failed" : docTypeLabel(d.document_type);
          return (
            <li className="batch-row" key={d.document_id}>
              {file ? (
                <a className="c-thumb" href={`/${file}`} target="_blank" rel="noopener noreferrer">
                  <img src={`/${file}`} alt="" />
                </a>
              ) : (
                <div className="c-thumb" />
              )}
              <div className="batch-row-main">
                <div className="batch-row-id">{d.document_id}</div>
                {d.doc_number ? <div className="c-ref">{d.doc_number}</div> : null}
              </div>
              <span className={`pill ${isWaiting(d) ? "s-working" : statusClass(d.status)}`} title={label}>
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
