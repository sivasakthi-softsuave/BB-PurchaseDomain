import { useRef, useState } from "react";
import { api } from "./lib/api.js";
import { TopNav } from "./components/TopNav.jsx";
import { ChatDock } from "./components/ChatDock.jsx";
import { HomeTab } from "./pages/home/HomeTab.jsx";
import { ProjectTab } from "./pages/project/ProjectTab.jsx";
import { DocumentsTab } from "./pages/documents/DocumentsTab.jsx";
import { ComparePage } from "./pages/compare/ComparePage.jsx";
import { UploadModal } from "./pages/home/UploadModal.jsx";
import { ScanModal } from "./pages/home/ScanModal.jsx";
import { AddProjectModal } from "./pages/home/AddProjectModal.jsx";
import { ReviewModal } from "./features/review/ReviewModal.jsx";
import { BatchSummaryModal } from "./features/review/BatchSummaryModal.jsx";
import { IncomingBatchModal } from "./features/review/IncomingBatchModal.jsx";
import { useConsoleData } from "./lib/useConsoleData.js";
import { useHashRoute } from "./lib/useHashRoute.js";
import { usePendingScans } from "./lib/usePendingScans.js";

/* Shell and routing only. Each tab owns its own filters; the shared data comes
   from one hook so all three read the same lists. */
export default function App() {
  const { tab, projectId, documentId } = useHashRoute();
  const { projects, docs, materials, reload, updatedAt } = useConsoleData();
  const { batches: pendingScans, refresh: refreshPendingScans } = usePendingScans();
  // A batch opened from the notification bell — independent of scanFor/
  // ScanModal, since the phone connection that produced it may be long
  // closed by the time the office gets back to deciding it.
  const [openPendingBatch, setOpenPendingBatch] = useState(null);

  /* Reachable from every tab, so they live up here rather than in one of them. */
  const [reviewId, setReviewId] = useState(null);
  // Freshly-uploaded documents queued to open into Review one after another —
  // see openReviewQueue/closeReview below and UploadModal's onUploaded.
  const [reviewQueue, setReviewQueue] = useState([]);
  const [addingProject, setAddingProject] = useState(false);
  const [uploadFor, setUploadFor] = useState(null);
  const [scanFor, setScanFor] = useState(null);
  // A freshly-uploaded batch, shown once as a summary (see BatchSummaryModal)
  // before any of it opens into Review — null once there is nothing to summarise.
  const [batchIds, setBatchIds] = useState(null);
  /* A document Compare's "Generate Purchase Bill" just created, opened
     straight into Review the same as any other document — but a generated
     one only ever asked to exist because a reviewer clicked Generate, not
     because a real page was scanned. If they walk away without an explicit
     Save/Approve/Reject, the generated document is deleted rather than left
     behind unreviewed — "generate" previews it, a review decision is what
     actually keeps it. A ref, not state: onChanged and onClose both need
     the current value synchronously, including right after a Save that just
     fired it, without waiting on a render. */
  const pendingGenerated = useRef(null); // { id, saved }

  const openReviewQueue = (ids) => {
    if (!ids?.length) return;
    setReviewId(ids[0]);
    setReviewQueue(ids.slice(1));
  };

  const openGenerated = (id) => {
    pendingGenerated.current = { id, saved: false };
    setReviewId(id);
  };

  const onReviewChanged = () => {
    if (pendingGenerated.current?.id === reviewId) pendingGenerated.current.saved = true;
    reload();
  };

  /* An upload no longer closes into a toast — it opens into the batch summary,
     then Review, the same screen clicking an existing document opens. Closing
     Review advances to the next freshly-uploaded document instead of just
     vanishing, so a multi-file upload walks through all of them in turn. */
  const closeReview = async () => {
    const pending = pendingGenerated.current;
    pendingGenerated.current = null;
    if (pending && pending.id === reviewId && !pending.saved) {
      await api.deleteDocument(pending.id).catch(() => {});
      reload();
    }
    if (reviewQueue.length) {
      setReviewId(reviewQueue[0]);
      setReviewQueue((q) => q.slice(1));
    } else {
      setReviewId(null);
    }
  };

  return (
    <div className="shell">
      <TopNav
        active={tab}
        onAddProject={() => setAddingProject(true)}
        pendingScans={pendingScans}
        onSelectPendingScan={setOpenPendingBatch}
      />

      <main id={`tab-${tab}`}>
        {tab === "home" ? (
          <HomeTab
            projects={projects}
            docs={docs}
            reload={reload}
            addingProject={addingProject}
            setAddingProject={setAddingProject}
            updatedAt={updatedAt}
          />
        ) : null}

        {tab === "project" ? (
          <ProjectTab
            projectId={projectId}
            projects={projects}
            docs={docs}
            materials={materials}
            reload={reload}
            onOpenDocument={setReviewId}
            onAddProject={() => setAddingProject(true)}
            onAddDocument={setUploadFor}
            onScan={setScanFor}
            onProcessed={setBatchIds}
          />
        ) : null}

        {tab === "documents" ? (
          <DocumentsTab
            docs={docs}
            projects={projects}
            onOpenDocument={setReviewId}
          />
        ) : null}

        {tab === "compare" ? (
          <ComparePage
            key={documentId}
            documentId={documentId}
            docs={docs}
            materials={materials}
            onOpenDocument={setReviewId}
            onOpenGenerated={openGenerated}
            reload={reload}
            onAddDocument={setUploadFor}
            onScan={setScanFor}
          />
        ) : null}
      </main>

      {reviewId ? (
        <ReviewModal
          key={reviewId}
          docId={reviewId}
          docs={docs}
          materials={materials}
          onClose={closeReview}
          onChanged={onReviewChanged}
        />
      ) : null}

      {/* Home renders its own copy while it owns the intake flow; this one
          covers the other tabs. */}
      {tab !== "home" && addingProject ? (
        <AddProjectModal onClose={() => setAddingProject(false)} onCreated={reload} />
      ) : null}

      {uploadFor ? (
        <UploadModal
          project={uploadFor}
          onClose={() => setUploadFor(null)}
          onUploaded={(ids) => { setUploadFor(null); reload(); setBatchIds(ids); }}
        />
      ) : null}

      {batchIds ? (
        <BatchSummaryModal
          ids={batchIds}
          onClose={() => setBatchIds(null)}
          onNext={() => { openReviewQueue(batchIds); setBatchIds(null); }}
        />
      ) : null}

      {/* Same QR-connect flow as the home tiles — reused rather than
          duplicated — reachable from the projects grid and a project's own
          page too, not just home. */}
      {scanFor ? (
        <ScanModal
          project={scanFor}
          onClose={() => setScanFor(null)}
          onProcess={(ids) => { setScanFor(null); reload(); refreshPendingScans(); setBatchIds(ids); }}
          onDraft={() => { reload(); refreshPendingScans(); }}
        />
      ) : null}

      {/* Reopened from the notification bell for a batch left undecided
          after its own Scan modal was closed — same decision, same
          component, just no QR/session screen behind it here. */}
      {openPendingBatch ? (
        <IncomingBatchModal
          documents={openPendingBatch.documents}
          onClose={() => setOpenPendingBatch(null)}
          onProcess={(ids) => {
            setOpenPendingBatch(null); reload(); refreshPendingScans(); setBatchIds(ids);
          }}
          onDraft={() => { setOpenPendingBatch(null); reload(); refreshPendingScans(); }}
        />
      ) : null}

      {/* Shell-level like the modals: a question outlives a tab switch. */}
      <ChatDock />
    </div>
  );
}
