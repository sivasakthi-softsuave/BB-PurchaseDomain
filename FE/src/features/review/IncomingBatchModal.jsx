import { useState } from "react";
import { Modal } from "../../components/Modal.jsx";
import { api } from "../../lib/api.js";

/* The Process/Draft decision for one batch of phone-scanned pages — shown
   either the moment it arrives (ScanModal, while that project's session is
   still open) or later, reopened from the notification bell for a batch
   that was left undecided. Either way it's the same choice against the same
   documents, so the UI and the decide() logic live here once.

   Both choices confirm the batch server-side first (clearing
   awaiting_scan_decision — see process_batch/draft_batch in
   Backend/main.py) before calling back — a failed request leaves the modal
   open to retry rather than silently dropping the batch. Closing without
   deciding (X, backdrop, Escape) does nothing at all: the batch stays
   exactly as undecided as it was, still owned by the notification bell. */
export function IncomingBatchModal({ documents, onProcess, onDraft, onClose }) {
  const [deciding, setDeciding] = useState(false);
  const [err, setErr] = useState("");

  const decide = async (action) => {
    const ids = documents.map((d) => d.document_id ?? d.id);
    setDeciding(true);
    setErr("");
    try {
      if (action === "draft") await api.draftDocuments(ids);
      else await api.processDocuments(ids);
      if (action === "draft") onDraft?.(ids);
      else onProcess?.(ids);
    } catch (e) {
      setErr(`Could not ${action === "draft" ? "save as draft" : "start processing"} — ${e.message}`);
    } finally {
      setDeciding(false);
    }
  };

  return (
    <Modal
      title="Documents received"
      subtitle={`${documents.length} document${documents.length === 1 ? "" : "s"} just came in from the phone`}
      wide
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-out" onClick={() => decide("draft")} disabled={deciding}>
            Draft
          </button>
          <button className="btn btn-ink" onClick={() => decide("process")} disabled={deciding}>
            Process
          </button>
        </>
      }
    >
      {err ? <div className="banner banner-err">{err}</div> : null}
      <ul className="batch-list">
        {documents.map((d) => {
          const id = d.document_id ?? d.id;
          const file = d.file_paths?.[0];
          return (
            <li className="batch-row" key={id}>
              {file ? (
                <a className="c-thumb" href={`/${file}`} target="_blank" rel="noopener noreferrer">
                  <img src={`/${file}`} alt="" />
                </a>
              ) : (
                <div className="c-thumb" />
              )}
              <div className="batch-row-main">
                <div className="batch-row-id">{id}</div>
                {d.project_name ? <div className="c-ref">{d.project_code} — {d.project_name}</div> : null}
              </div>
              <span className="pill" title={`${d.page_count} page${d.page_count === 1 ? "" : "s"}`}>
                {d.page_count} page{d.page_count === 1 ? "" : "s"}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="hint">
        Process reads these now. Draft leaves them in Documents, unread, for later.
      </p>
    </Modal>
  );
}
