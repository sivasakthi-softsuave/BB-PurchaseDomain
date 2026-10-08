import { useEffect } from "react";
import { IconClose } from "./Icons.jsx";

/* One modal shell for every dialog: backdrop click and Escape both close, and
   the caller owns the body and footer.

   closable defaults to true — ReviewModal is the one caller that ever
   passes false, while a document is still being extracted and there's
   nothing yet to dismiss back to. The X is disabled rather than hidden in
   that state, so its absence doesn't read as a layout glitch, and Escape /
   backdrop-click are skipped so all three ways of leaving agree. onClose
   still runs the caller's own logic either way (ReviewModal's attemptClose
   already no-ops for the cases that matter) — this is only the visible half
   of that gate. */
export function Modal({
  title, subtitle, wide = false, closable = true, glacier = false, maxWidth, onClose, children, footer,
  headerExtra,
}) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && closable) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, closable]);

  return (
    <div
      className={`backdrop ${glacier ? "backdrop-glacier" : ""}`}
      onMouseDown={(e) => { if (closable && e.target === e.currentTarget) onClose(); }}
    >
      <div
        className={`modal ${wide ? "modal-lg" : ""} ${glacier ? "modal-glacier" : ""}`}
        style={maxWidth ? { maxWidth } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <div className="for">{subtitle}</div> : null}
          </div>
          <div className="spacer" />
          {headerExtra}
          <button
            className="close-x"
            onClick={onClose}
            disabled={!closable}
            aria-label="Close"
            title={closable ? undefined : "Still processing — this closes once it's read"}
          >
            <IconClose />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
