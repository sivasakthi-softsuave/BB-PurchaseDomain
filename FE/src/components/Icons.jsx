/* Stroke-based icons on a 24px grid, one consistent weight. Inline SVG rather
   than emoji: emoji render differently per OS and cannot take a brand colour. */

const base = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

export const IconUpload = (p) => (
  <svg {...base} {...p}>
    <path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 18v2h16v-2" />
  </svg>
);

/* Upload's arrow, reversed — the pair reads as in and out of the system. */
export const IconDownload = (p) => (
  <svg {...base} {...p}>
    <path d="M12 4v12" /><path d="M7 11l5 5 5-5" /><path d="M4 18v2h16v-2" />
  </svg>
);

export const IconFolder = (p) => (
  <svg {...base} {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

export const IconGallery = (p) => (
  <svg {...base} {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="8.5" cy="9.5" r="1.6" /><path d="M4 17l5-4 4 3 3-2 4 3" />
  </svg>
);

export const IconArrow = (p) => (
  <svg {...base} {...p}><path d="M5 12h13" /><path d="M12 6l6 6-6 6" /></svg>
);

export const IconPlus = (p) => (
  <svg {...base} {...p}><path d="M12 5v14" /><path d="M5 12h14" /></svg>
);

export const IconClose = (p) => (
  <svg {...base} {...p}><path d="M6 6l12 12" /><path d="M18 6L6 18" /></svg>
);

export const IconRefresh = (p) => (
  <svg {...base} {...p}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20 4v5h-5" />
  </svg>
);

export const IconPhone = (p) => (
  <svg {...base} {...p}>
    <rect x="7" y="3" width="10" height="18" rx="2.5" /><path d="M11 18.5h2" />
  </svg>
);

export const IconPrint = (p) => (
  <svg {...base} {...p}>
    <path d="M7 8V4h10v4" /><rect x="4" y="8" width="16" height="7" rx="2" />
    <path d="M7 15h10v5H7z" />
  </svg>
);

export const IconFile = (p) => (
  <svg {...base} {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
);

export const IconBack = (p) => (
  <svg {...base} {...p}><path d="M19 12H6" /><path d="M12 6l-6 6 6 6" /></svg>
);

export const IconHome = (p) => (
  <svg {...base} {...p}><path d="M4 11l8-7 8 7" /><path d="M6 10v9h12v-9" /></svg>
);

export const IconSearch = (p) => (
  <svg {...base} {...p}><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></svg>
);

export const IconCheck = (p) => (
  <svg {...base} {...p}><path d="M20 6L9 17l-5-5" /></svg>
);

/* Circle-enclosed variants — one glyph carries its own "badge" shape, so a
   status tile doesn't need a separate colored circle wrapper behind a plain
   glyph just to read as a status icon. */
export const IconCheckCircle = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" /><path d="M8.2 12.3l2.4 2.4L15.8 9" />
  </svg>
);

export const IconXCircle = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" /><path d="M9 9l6 6M15 9l-6 6" />
  </svg>
);

/* Rotated 90deg via .is-open rather than swapped for a down-chevron: one
   element, one transition, instead of two icons crossfading. */
export const IconChevron = (p) => (
  <svg {...base} {...p}><path d="M9 6l6 6-6 6" /></svg>
);

export const IconChat = (p) => (
  <svg {...base} {...p}>
    <path d="M20 14a3 3 0 0 1-3 3H8l-4 3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" />
  </svg>
);

export const IconSend = (p) => (
  <svg {...base} {...p}><path d="M4 12h15" /><path d="M13 6l6 6-6 6" /></svg>
);

export const IconTrash = (p) => (
  <svg {...base} {...p}>
    <path d="M4 7h16" /><path d="M9 7V4h6v3" />
    <path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
    <path d="M10 11v6" /><path d="M14 11v6" />
  </svg>
);

export const IconClock = (p) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3.2 2" /></svg>
);

export const IconGrid = (p) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.5" />
    <rect x="13" y="3.5" width="7.5" height="7.5" rx="1.5" />
    <rect x="3.5" y="13" width="7.5" height="7.5" rx="1.5" />
    <rect x="13" y="13" width="7.5" height="7.5" rx="1.5" />
  </svg>
);

export const IconList = (p) => (
  <svg {...base} {...p}>
    <path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" />
    <path d="M3.5 6h.01" /><path d="M3.5 12h.01" /><path d="M3.5 18h.01" />
  </svg>
);

/* A lined document — the page count, distinct from IconFile's plain folded
   corner (the document count) beside it. */
export const IconPages = (p) => (
  <svg {...base} {...p}>
    <path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M9 8h6M9 12h6M9 16h4" />
  </svg>
);

/* An open crate — what a purchase order actually is, materials packaged up
   and on their way. */
export const IconPackage = (p) => (
  <svg {...base} {...p}>
    <path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" />
  </svg>
);

/* Stacked stock — the material rollup, one slab per kind on site. */
export const IconLayers = (p) => (
  <svg {...base} {...p}>
    <path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /><path d="M3 18l9 5 9-5" />
  </svg>
);

export const IconEye = (p) => (
  <svg {...base} {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconBuilding = (p) => (
  <svg {...base} {...p}>
    <rect x="4" y="7" width="7" height="13" rx="1" /><rect x="13" y="3" width="7" height="17" rx="1" />
    <path d="M7 11h1M7 14h1M7 17h1M16 7h1M16 10h1M16 13h1M16 16h1" />
  </svg>
);

export const IconExternalLink = (p) => (
  <svg {...base} {...p}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <path d="M15 3h6v6" /><path d="M10 14L21 3" />
  </svg>
);

export const IconZoomIn = (p) => (
  <svg {...base} {...p}>
    <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /><path d="M11 8.5v5M8.5 11h5" />
  </svg>
);

export const IconZoomOut = (p) => (
  <svg {...base} {...p}>
    <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /><path d="M8.5 11h5" />
  </svg>
);

/* The delivery — materials packaged and moving, the same idea IconPackage
   already stands for, just in transit rather than sitting on a shelf. */
export const IconTruck = (p) => (
  <svg {...base} {...p}>
    <rect x="1.5" y="7" width="13" height="10" rx="1" />
    <path d="M14.5 10h4l3 3.5V17h-7z" />
    <circle cx="6" cy="18.5" r="1.8" /><circle cx="17.5" cy="18.5" r="1.8" />
  </svg>
);

/* A machine read this, not a person — the badge beside "AI extracted". */
export const IconSparkle = (p) => (
  <svg {...base} {...p}>
    <path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z" />
  </svg>
);

export const IconAlertTriangle = (p) => (
  <svg {...base} {...p}>
    <path d="M12 4l9.5 16H2.5z" /><path d="M12 10v4" /><path d="M12 17.5h.01" />
  </svg>
);

export const IconEdit = (p) => (
  <svg {...base} {...p}>
    <path d="M4 20l1-4.5L15.5 5 19 8.5 8.5 19z" /><path d="M13.5 6.5L17.5 10.5" />
  </svg>
);

export const IconBell = (p) => (
  <svg {...base} {...p}>
    <path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6z" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </svg>
);
