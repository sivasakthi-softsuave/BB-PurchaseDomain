import { useEffect, useRef, useState } from "react";
import { IconBell } from "./Icons.jsx";

function timeAgo(sqliteUtc) {
  if (!sqliteUtc) return "just now";
  // SQLite's datetime('now') has no timezone suffix but is UTC — without a
  // "Z", `new Date(...)` parses it as local time and every "ago" reads hours
  // off in any timezone ahead of UTC.
  const ms = Date.now() - new Date(`${sqliteUtc}Z`).getTime();
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/* Global, not tied to any one tab — the only always-visible sign that a
   phone sent documents the console hasn't decided Process or Draft for yet.
   The red dot is driven purely by usePendingScans' batches: opening this
   dropdown, or the decision modal it leads to, never clears it — only an
   actual Process/Draft confirmation does, by making the batch disappear
   from the next poll. */
export function NotificationBell({ batches, onSelect }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const count = batches.length;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="icon-btn"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={count ? `${count} scan${count === 1 ? "" : "s"} awaiting a decision` : "No pending scans"}
      >
        <IconBell width={18} height={18} />
        {count ? <span className="notif-dot" /> : null}
      </button>

      {open ? (
        <div className="menu notif-menu">
          {count === 0 ? (
            <div className="notif-empty">Nothing waiting from the phone.</div>
          ) : (
            batches.map((b) => (
              <button
                key={b.sessionId ?? b.documents[0]?.document_id}
                type="button"
                onClick={() => { setOpen(false); onSelect(b); }}
              >
                <span className="ico"><IconBell width={16} height={16} /></span>
                <span>
                  <span className="t">
                    {b.documents.length} document{b.documents.length === 1 ? "" : "s"}
                    {b.projectCode ? ` — ${b.projectCode}` : ""}
                  </span>
                  <span className="d">Scanned {timeAgo(b.uploadedAt)} — tap to Process or Draft</span>
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
