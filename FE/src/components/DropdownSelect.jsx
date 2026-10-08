import { useEffect, useRef, useState } from "react";
import { IconChevron } from "./Icons.jsx";

/* The same floating-list dropdown ProjectGrid's own Sort/Status filters and
   the dashboard charts' project picker already build by hand — pulled out
   once it was about to be hand-built a third time. Not a native <select>:
   the one control a browser insists on rendering its own way (including its
   open option list's hover colour) no matter how the rest of the app looks.
   `options` is [{ value, label }]; value/onChange work the same as a plain
   <select>'s would. */
export function DropdownSelect({ value, options, onChange, ariaLabel, className = "" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className={`combo filter-combo ${className}`} ref={ref}>
      <button
        type="button"
        className="ctl filter-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span>{current?.label}</span>
        <IconChevron width={13} height={13} className={`filter-chevron ${open ? "is-open" : ""}`} />
      </button>
      {open ? (
        <div className="combo-menu" role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={o.value === value ? "is-selected" : ""}
              aria-selected={o.value === value}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
