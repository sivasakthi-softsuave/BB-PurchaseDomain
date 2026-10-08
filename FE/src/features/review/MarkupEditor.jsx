import { useEffect, useRef, useState } from "react";
import { IconUndo } from "../../components/Icons.jsx";

const COLORS = ["#e0393e", "#1a1a19", "#2f6fed", "#eab308"];

/* A single freehand pencil over the page image, full screen so a reviewer
   has room to actually mark something on a dense scan. Drawn onto a canvas
   sized to the image's own natural pixels — not the on-screen display size —
   so Save flattens it back out at the same resolution the page was stored
   at, rather than upscaling a small on-screen stroke into a blurry blob.

   Strokes are kept as points rather than baked permanently into the canvas,
   so Undo can pop the last one and redraw the image plus what's left —
   the only way to "erase" ink already painted onto a flat canvas. */
export function MarkupEditor({ imageUrl, mimeType, onClose, onSave }) {
  const canvasRef = useRef(null);
  const imgElRef = useRef(null);
  const strokesRef = useRef([]);
  const drawingRef = useRef(null);
  const [color, setColor] = useState(COLORS[0]);
  const [ready, setReady] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      imgElRef.current = img;
      const canvas = canvasRef.current;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      redraw();
      setReady(true);
    };
    img.onerror = () => { if (!cancelled) setErr("Could not load the page image."); };
    img.src = imageUrl;
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  function redraw() {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (imgElRef.current) ctx.drawImage(imgElRef.current, 0, 0, canvas.width, canvas.height);
    strokesRef.current.forEach((stroke) => paintStroke(ctx, stroke));
  }

  function paintStroke(ctx, stroke) {
    if (stroke.points.length < 2) return;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    stroke.points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.stroke();
  }

  // The canvas is drawn at the image's own pixel size but displayed scaled
  // to fit the screen (see .markup-canvas), so a pointer position has to be
  // converted from on-screen pixels back into that native space.
  function toCanvasPoint(e) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  const strokeWidth = () => Math.max(4, (canvasRef.current?.width ?? 1000) / 220);

  function onPointerDown(e) {
    if (!ready || saving) return;
    e.preventDefault();
    canvasRef.current.setPointerCapture(e.pointerId);
    drawingRef.current = { color, width: strokeWidth(), points: [toCanvasPoint(e)] };
  }

  function onPointerMove(e) {
    if (!drawingRef.current) return;
    const point = toCanvasPoint(e);
    const pts = drawingRef.current.points;
    const ctx = canvasRef.current.getContext("2d");
    ctx.strokeStyle = drawingRef.current.color;
    ctx.lineWidth = drawingRef.current.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    pts.push(point);
  }

  function onPointerUp() {
    if (!drawingRef.current) return;
    if (drawingRef.current.points.length > 1) {
      strokesRef.current.push(drawingRef.current);
      setCanUndo(true);
    }
    drawingRef.current = null;
  }

  function undo() {
    strokesRef.current.pop();
    setCanUndo(strokesRef.current.length > 0);
    redraw();
  }

  function save() {
    setErr("");
    setSaving(true);
    canvasRef.current.toBlob(async (blob) => {
      if (!blob) { setErr("Could not render the marked-up image."); setSaving(false); return; }
      try {
        await onSave(blob);
      } catch (e) {
        setErr(`Could not save — ${e.message}`);
        setSaving(false);
      }
    }, mimeType, 0.92);
  }

  return (
    <div className="backdrop markup-backdrop">
      <div className="markup-shell">
        <div className="markup-toolbar">
          <div className="markup-colors">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`markup-swatch ${c === color ? "is-active" : ""}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={`Pencil colour ${c}`}
                disabled={saving}
              />
            ))}
          </div>
          <div className="spacer" />
          <button type="button" className="btn btn-quiet btn-xs" onClick={undo} disabled={!canUndo || saving}>
            <IconUndo /> Undo
          </button>
          <button type="button" className="btn btn-out btn-xs" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn btn-ink btn-xs" onClick={save} disabled={!ready || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>

        <div className="markup-canvas-wrap">
          {!ready ? <div className="empty">Loading…</div> : null}
          <canvas
            ref={canvasRef}
            className="markup-canvas"
            style={{ display: ready ? "block" : "none" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          />
        </div>

        {err ? <div className="banner banner-err markup-err">{err}</div> : null}
      </div>
    </div>
  );
}

/* .jpg/.jpeg round-trip as image/jpeg so the file on disk stays the same
   kind it was uploaded as — canvas.toBlob defaults to image/png otherwise,
   which would silently change the format of a re-saved JPEG page. */
export function mimeTypeForPath(path) {
  const clean = path.split("?")[0];
  const ext = (clean.split(".").pop() ?? "").toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "image/png";
}
