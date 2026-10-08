import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

const POLL_MS = 5000;

/* App-wide, not tied to any one tab or modal: a scanned batch the console
   hasn't chosen Process or Draft for is invisible everywhere else (see
   awaiting_scan_decision in Backend/main.py), so this is the one place that
   still knows it exists — what the notification bell reads from, and what
   lets a batch be reopened and decided long after the Scan modal that
   received it has been closed.

   Grouped by session_id: one phone connection can send several "Send All"
   batches before the office ever looks, and Process/Draft already decide a
   whole session's undecided documents at once (see IncomingBatchModal), so a
   session is the natural unit here too. */
export function usePendingScans() {
  const [pending, setPending] = useState([]);

  const refresh = useCallback(async () => {
    try {
      setPending(await api.listDocuments({ awaiting_decision: true }));
    } catch {
      // transient — the next tick tries again, nothing to show meanwhile
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const tick = async () => {
      if (!cancelled) await refresh();
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };

    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [refresh]);

  const batches = Object.values(
    pending.reduce((groups, d) => {
      const key = d.session_id ?? d.document_id;
      const group = groups[key] ?? {
        sessionId: d.session_id,
        projectId: d.project_id,
        projectCode: d.project_code,
        projectName: d.project_name,
        uploadedAt: d.uploaded_at,
        documents: [],
      };
      group.documents.push(d);
      if (d.uploaded_at > group.uploadedAt) group.uploadedAt = d.uploaded_at;
      groups[key] = group;
      return groups;
    }, {}),
  ).sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));

  return { batches, refresh };
}
