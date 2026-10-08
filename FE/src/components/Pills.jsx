import { docTypeLabel, statusClass } from "../lib/format.js";

/* Filled pill = status, the thing you scan a list for.
   Outlined pill = type, secondary metadata. See app.css for why. */

export const StatusPill = ({ status }) => (
  <span className={`pill ${statusClass(status)}`} title={status}>{status}</span>
);

export const TypePill = ({ type }) => {
  const label = docTypeLabel(type);
  // Only past 11 characters — "Purchase Bill"/"Unclassified" are the two
  // that actually run long in the Document Register's own Type column;
  // nothing shorter needs the hover round-trip to read in full.
  return (
    <span className="pill pill-type" title={label.length > 11 ? label : undefined}>
      {label}
    </span>
  );
};
