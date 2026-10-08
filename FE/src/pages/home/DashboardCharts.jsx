import { useEffect, useRef, useState } from "react";
import { IconChevron } from "../../components/Icons.jsx";
import { compactMoney, countsTowardTotals, docTypeLabel, projectTally } from "../../lib/format.js";

/* Rounds a chart's ceiling up to a clean 1/2/2.5/5/10 × 10^n step, the way a
   real axis is drawn by hand — so gridlines read "₹12L, ₹9L, ₹6L..." instead
   of some jagged fraction of whatever the largest bar happens to be. */
function niceCeil(value) {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}

/* Project-wise Value Booked — the primary chart. One bar per project with
   any booked value, tallest first; the shape a reviewer already knows from
   the metric cards above, just broken out by project. */
function ValueByProjectChart({ projects, docs }) {
  // { id, x, y } while a mouse tracks across the bar itself — x/y are only
  // ever set from a real pointer move, so keyboard focus (no coordinates to
  // give) falls back to the tooltip's own default top-centred CSS position.
  const [hover, setHover] = useState(null);
  const rows = projects
    .map((p) => ({ id: p.id, label: p.name || p.code, value: projectTally(p, docs).booked }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  if (!rows.length) {
    return <div className="chart-empty">No value booked yet.</div>;
  }

  const ceiling = niceCeil(Math.max(...rows.map((r) => r.value)));
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((f) => ceiling * f);

  return (
    <div className="bar-chart">
      <div className="bar-chart-axis">
        {ticks.map((t) => (
          <span key={t}>{t === 0 ? "0" : compactMoney(t)}</span>
        ))}
      </div>
      <div className="bar-chart-plot">
        {rows.map((r) => (
          <div className="bar-col" key={r.id}>
            <span className="bar-value">{compactMoney(r.value)}</span>
            <span
              className="bar"
              tabIndex={0}
              style={{
                height: `${(r.value / ceiling) * 100}%`,
                opacity: hover && hover.id !== r.id ? 0.45 : 1,
              }}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setHover({ id: r.id, x: e.clientX - rect.left, y: e.clientY - rect.top });
              }}
              onMouseLeave={() => setHover((h) => (h?.id === r.id ? null : h))}
              onFocus={() => setHover({ id: r.id })}
              onBlur={() => setHover((h) => (h?.id === r.id ? null : h))}
            >
              {/* Tracks the pointer while it moves across this bar; on
                  keyboard focus (no x/y) it falls back to sitting at the
                  bar's own top-centre — see .bar-tooltip's own default. */}
              {hover?.id === r.id ? (
                <span
                  className="bar-tooltip"
                  style={hover.x != null
                    ? { left: hover.x, top: hover.y, transform: "translate(-50%, -130%)" }
                    : undefined}
                >
                  {r.label}
                </span>
              ) : null}
            </span>
            <span className="bar-label">{r.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* Documents by Type — the secondary chart. Only Invoice/PO/MIN/Purchase Bill
   get their own slice; everything else (delivery challans, quotations,
   still-unclassified pages) folds into "Others" so five calm slices always
   answer "what kind of paper is this portfolio mostly made of." Every
   colour is still one of the app's own tokens (ink/accent-tint/warn/slate/
   dust) — a wider spread across the palette than one blue family, but never
   a colour the app doesn't already use somewhere else. */
const LIGHT_BLUE = "color-mix(in srgb, var(--accent) 62%, white)";
// The app's amber is a pale-cream/dark-brown text pair (built for contrast,
// not for a filled shape) — blending the two gives the mid-tone gold this
// wedge needs without inventing a colour the app doesn't already use.
const AMBER_FILL = "color-mix(in srgb, var(--warn-fg) 55%, var(--warn-bg))";
const TYPE_SLICES = [
  { key: "INVOICE", color: "var(--ink)" },
  { key: "PO", color: LIGHT_BLUE },
  { key: "INWARD", color: AMBER_FILL },
  { key: "PURCHASE_BILL", color: "var(--slate)" },
];
const OTHER_COLOR = "var(--dust)";

/* Ring radius/stroke live in a 0-100 viewBox — pathLength="100" on every
   circle re-maps that same circle's own dasharray/dashoffset units to plain
   percentages, so a bucket's slice is just [pct, 100-pct] and an offset of
   -cumBefore, no circumference math anywhere. Rotated -90deg so the first
   slice starts at 12 o'clock, same reading order the legend lists below it. */
const RING_R = 40;
const RING_STROKE = 18;

function DocumentsByTypeChart({ docs }) {
  const [hovered, setHovered] = useState(null);
  const total = docs.length;
  const counts = {};
  for (const d of docs) counts[d.document_type] = (counts[d.document_type] || 0) + 1;

  const named = TYPE_SLICES.map((t) => ({ ...t, label: docTypeLabel(t.key), count: counts[t.key] || 0 }));
  const otherCount = total - named.reduce((sum, t) => sum + t.count, 0);
  const buckets = [...named, { key: "OTHER", color: OTHER_COLOR, label: "Others", count: otherCount }]
    .filter((b) => b.count > 0);

  if (!total) {
    return <div className="chart-empty">No documents yet.</div>;
  }

  let cum = 0;
  const slices = buckets.map((b) => {
    const pct = (b.count / total) * 100;
    const start = cum;
    cum += pct;
    return { ...b, pct, start };
  });

  const active = slices.find((s) => s.key === hovered);
  // The tooltip's own anchor — the midpoint of the hovered slice's own arc,
  // just outside the ring — computed from the data, not the pointer, so it
  // never has to track a live mousemove to land in the right place.
  const anchor = active
    ? (() => {
        const midDeg = -90 + ((active.start + active.pct / 2) / 100) * 360;
        const rad = (midDeg * Math.PI) / 180;
        const r = RING_R + RING_STROKE / 2 + 6;
        return { x: 50 + r * Math.cos(rad), y: 50 + r * Math.sin(rad) };
      })()
    : null;

  const enter = (key) => () => setHovered(key);
  const leave = () => setHovered(null);

  return (
    <div className="donut-chart">
      <div className="donut-ring-wrap">
        <svg
          className="donut-ring"
          viewBox="0 0 100 100"
          role="img"
          aria-label={`Documents by type: ${slices.map((s) => `${s.label} ${Math.round(s.pct)}%`).join(", ")}`}
        >
          <g transform="rotate(-90 50 50)">
            {slices.map((s) => (
              <circle
                key={s.key}
                r={RING_R}
                cx="50"
                cy="50"
                fill="none"
                stroke={s.color}
                strokeWidth={hovered === s.key ? RING_STROKE + 3 : RING_STROKE}
                strokeDasharray={`${s.pct} ${100 - s.pct}`}
                strokeDashoffset={-s.start}
                pathLength="100"
                opacity={hovered && hovered !== s.key ? 0.45 : 1}
                tabIndex={0}
                role="button"
                aria-label={`${s.label}: ${Math.round(s.pct)}%`}
                onMouseEnter={enter(s.key)}
                onMouseLeave={leave}
                onFocus={enter(s.key)}
                onBlur={leave}
                style={{ cursor: "pointer", transition: "stroke-width .1s ease, opacity .1s ease" }}
              />
            ))}
          </g>
        </svg>
        <div className="donut-center">
          <div className="donut-total">{total}</div>
          <div className="donut-total-label">Documents</div>
        </div>
        {active && anchor ? (
          <div
            className="donut-tooltip"
            style={{ left: `${anchor.x}%`, top: `${anchor.y}%` }}
          >
            <span className="donut-tooltip-value">{Math.round(active.pct)}%</span>
            <span className="donut-tooltip-label">{active.label}</span>
          </div>
        ) : null}
      </div>
      <ul className="donut-legend">
        {slices.map((s) => (
          <li key={s.key}>
            <span className="legend-dot" style={{ background: s.color }} />
            <span className="legend-label">{s.label}</span>
            <span className="legend-count">{s.count}</span>
            <span className="legend-pct">{Math.round(s.pct)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* Both charts share one project filter — "All projects" by default, or one
   project's own slice of the same two questions ("what did it cost" /
   "what kind of paper was it"). A dropdown per card rather than one shared
   control above both, since each card still reads as a complete, standalone
   answer on its own.

   A custom floating list, not a native <select> — same .combo/.combo-menu
   pattern ProjectGrid's own FilterMenu already builds its sort/status
   dropdowns from, since a native select's open option list is rendered by
   the OS/browser and its hover colour can't be restyled from here. */
function ProjectFilter({ projects, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const options = [
    { value: "", label: "All projects" },
    ...projects.map((p) => ({ value: p.id, label: p.code || p.name })),
  ];
  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className="combo filter-combo" ref={ref}>
      <button
        type="button"
        className="ctl ctl-xs chart-filter filter-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{current.label}</span>
        <IconChevron width={12} height={12} className={`filter-chevron ${open ? "is-open" : ""}`} />
      </button>
      {open ? (
        <div className="combo-menu" role="listbox">
          {options.map((o) => (
            <button
              key={o.value || "all"}
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

export function DashboardCharts({ projects, docs }) {
  const [projectId, setProjectId] = useState("");
  const scoped = projectId ? docs.filter((d) => d.project_id === projectId) : docs;
  const scopedProjects = projectId ? projects.filter((p) => p.id === projectId) : projects;
  const counted = scoped.filter(countsTowardTotals);

  return (
    <div className="section section-analytics">
      <div className="section-head">
        <span className="eyebrow">Analytics</span>
      </div>

      <div className="analytics-grid">
        <div className="chart-card chart-card-primary">
          <div className="chart-card-head">
            <div>
              <h3>Project-wise Value Booked</h3>
              <p className="chart-sub">Total value of materials booked per project</p>
            </div>
            <ProjectFilter projects={projects} value={projectId} onChange={setProjectId} />
          </div>
          <ValueByProjectChart projects={scopedProjects} docs={counted} />
        </div>

        <div className="chart-card chart-card-secondary">
          <div className="chart-card-head">
            <div>
              <h3>Documents by Type</h3>
              <p className="chart-sub">Breakdown of captured documents</p>
            </div>
            <ProjectFilter projects={projects} value={projectId} onChange={setProjectId} />
          </div>
          <DocumentsByTypeChart docs={scoped} />
        </div>
      </div>
    </div>
  );
}
