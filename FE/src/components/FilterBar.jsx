import { DropdownSelect } from "./DropdownSelect.jsx";
import { DOC_STATUSES, DOC_TYPES, docTypeLabel } from "../lib/format.js";

const title = (s) => { const w = s.replace(/_/g, " "); return w.charAt(0) + w.slice(1).toLowerCase(); };

/* One filter bar for both the project detail and the material gallery — the
   caller says which controls it wants and owns the filter object. */
export function FilterBar({
  value,
  onChange,
  projects = null,   // pass a project list to show the project select
  dates = false,
  placeholder = "Search document ID or project…",
  actions = null,    // extra controls (e.g. bulk Process/Delete) on the same line as the filters
}) {
  const set = (patch) => onChange({ ...value, ...patch });

  return (
    <div className="filter-bar">
      <input
        className="input input-search"
        type="search"
        placeholder={placeholder}
        value={value.q ?? ""}
        onChange={(e) => set({ q: e.target.value })}
        aria-label={placeholder}
      />

      {projects ? (
        <DropdownSelect
          className="filter-bar-combo"
          ariaLabel="Filter by project"
          value={value.project ?? ""}
          onChange={(v) => set({ project: v })}
          options={[
            { value: "", label: "All projects" },
            ...projects.map((p) => ({ value: p.id, label: p.code })),
          ]}
        />
      ) : null}

      <DropdownSelect
        className="filter-bar-combo"
        ariaLabel="Filter by document type"
        value={value.type ?? ""}
        onChange={(v) => set({ type: v })}
        options={[
          { value: "", label: "All types" },
          ...DOC_TYPES.map((t) => ({ value: t, label: docTypeLabel(t) })),
        ]}
      />

      <DropdownSelect
        className="filter-bar-combo"
        ariaLabel="Filter by status"
        value={value.status ?? ""}
        onChange={(v) => set({ status: v })}
        options={[
          { value: "", label: "All statuses" },
          ...DOC_STATUSES.map((s) => ({ value: s, label: title(s) })),
        ]}
      />

      {dates ? (
        <>
          <label>
            From
            <input
              className="input"
              type="date"
              value={value.from ?? ""}
              onChange={(e) => set({ from: e.target.value })}
            />
          </label>
          <label>
            To
            <input
              className="input"
              type="date"
              value={value.to ?? ""}
              onChange={(e) => set({ to: e.target.value })}
            />
          </label>
        </>
      ) : null}

      {actions ? <div className="filter-bar-actions">{actions}</div> : null}
    </div>
  );
}
