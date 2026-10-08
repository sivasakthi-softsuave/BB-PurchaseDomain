import { go } from "../lib/useHashRoute.js";
import { IconFolder, IconGallery, IconHome, IconPlus } from "./Icons.jsx";
import { NotificationBell } from "./NotificationBell.jsx";

const ITEMS = [
  { tab: "home", label: "Home", Icon: IconHome },
  { tab: "project", label: "Projects", Icon: IconFolder },
  { tab: "documents", label: "Documents", Icon: IconGallery },
];

/* The floating nav pill. "+ Add project" only shows outside Home — Home has
   its own way in (the Projects tab, and the tile at the end of the grid
   there), so repeating the button on every screen just to leave it off one
   would be backwards; leaving it off Home specifically is the one exception
   asked for. */
export function TopNav({ active, onAddProject, pendingScans, onSelectPendingScan }) {
  return (
    <div className="nav-rail">
      <nav className="nav" aria-label="Sections">
        <div className="brand"><span className="brand-red">Purchase</span>Division</div>

        <div className="nav-links">
          {ITEMS.map(({ tab, label, Icon }) => (
            <button
              key={tab}
              type="button"
              aria-current={active === tab ? "page" : undefined}
              onClick={() => go(`/${tab}`)}
            >
              <Icon width={17} height={17} />
              {label}
            </button>
          ))}
        </div>

        <div className="spacer" />

        <NotificationBell batches={pendingScans} onSelect={onSelectPendingScan} />

        {active !== "home" ? (
          <button className="btn btn-ink btn-sm" type="button" onClick={onAddProject}>
            <IconPlus width={17} height={17} />
            Add project
          </button>
        ) : null}
      </nav>
    </div>
  );
}
