import { useMemo, useState } from "react";
import { IconBack, IconPlus, IconTrash } from "../../components/Icons.jsx";
import { AddDocumentMenu } from "../../components/AddDocumentMenu.jsx";
import { DocumentsSection } from "../../components/DocumentsSection.jsx";
import { Modal } from "../../components/Modal.jsx";
import { MaterialsRollup } from "./MaterialsRollup.jsx";
import { PurchaseOrdersSection } from "./PurchaseOrdersSection.jsx";
import { QuoteAnalysisSection } from "./QuoteAnalysisSection.jsx";
import { go } from "../../lib/useHashRoute.js";
import { api } from "../../lib/api.js";
import { countsTowardTotals, money, projectTally } from "../../lib/format.js";

/* Purchase Orders and Quote Analysis are the project's two real tabs —
   the ongoing work a reviewer actually tracks. Documents and Materials are
   reference lookups underneath that, not their own destinations, so they
   sit as plain buttons instead of competing for tab billing — see
   docsOpen/materialsOpen below. */
const SECTIONS = [
  { id: "po", label: "Purchase Orders" },
  { id: "quotes", label: "Quote Analysis" },
];

export function ProjectDetail({
  project, docs, materials, reload, onOpenDocument, onAddDocument, onScan, onProcessed,
}) {
  const [section, setSection] = useState("po");
  // Owned here rather than inside QuoteAnalysisSection so the button that
  // flips it can sit in the shared tab row instead of its own header line.
  const [quoteUploading, setQuoteUploading] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState("");

  const deleteProject = async () => {
    setDeleting(true);
    setDeleteErr("");
    try {
      await api.deleteProject(project.id);
      await reload();
      go("/project");
    } catch (e) {
      setDeleteErr(`Could not delete — ${e.message}`);
      setDeleting(false);
    }
  };

  const projectDocs = useMemo(
    () => docs.filter((d) => d.project_id === project.id),
    [docs, project.id]
  );

  /* The materials rollup must exclude rejected documents; nothing else here
     filters the project's own document set any further. */
  const counted = useMemo(() => projectDocs.filter(countsTowardTotals), [projectDocs]);
  const rejectedInView = projectDocs.length - counted.length;

  const tally = projectTally(project, docs);

  return (
    <div className="band">
      <div className="col">

        <div className="phead">
          <button className="back" type="button" onClick={() => go("/project")}>
            <IconBack width={16} height={16} />
            All projects
          </button>

          <div className="phead-main">
            <div>
              {/* Name leads (the "code" styling is just the bigger,
                  bolder look — reused here for whichever field is primary,
                  not literally the project's own code field). */}
              <div className="code">{project.name}</div>
              <div className="pname">{project.code}</div>
            </div>
            <div className="spacer" />
            <div className="phead-actions">
              <AddDocumentMenu
                onScan={() => onScan(project)}
                onUpload={() => onAddDocument(project)}
              />
              <button
                className="icon-btn-danger"
                type="button"
                aria-label="Delete project"
                title="Delete project"
                onClick={() => setConfirmingDelete(true)}
              >
                <IconTrash width={16} height={16} />
              </button>
            </div>
          </div>

          {/* The project's own numbers on a hairline — a stat strip here would
              be four more boxes on a page whose problem was boxes. */}
          <div className="phead-meta">
            <span><b>{tally.documents}</b> documents</span>
            {tally.awaiting ? (
              <>
                <span className="sep">·</span>
                <span className="warn"><b>{tally.awaiting}</b> awaiting review</span>
              </>
            ) : null}
            {tally.reading ? (
              <>
                <span className="sep">·</span>
                <span><b>{tally.reading}</b> still reading</span>
              </>
            ) : null}
            {tally.booked ? (
              <>
                <span className="sep">·</span>
                <span><b>{money(tally.booked)}</b> booked</span>
              </>
            ) : null}
            <div className="spacer" />
            <button className="btn btn-quiet btn-xs" type="button" onClick={() => setDocsOpen(true)}>
              Documents
            </button>
            <button className="btn btn-quiet btn-xs" type="button" onClick={() => setMaterialsOpen(true)}>
              Materials
            </button>
          </div>
        </div>

        <div className="ptabs">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-current={section === s.id}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
          {section === "quotes" ? (
            <>
              <div className="spacer" />
              <button
                className="btn btn-ink btn-sm"
                type="button"
                onClick={() => setQuoteUploading(true)}
              >
                <IconPlus width={17} height={17} />
                Upload quotation
              </button>
            </>
          ) : null}
        </div>

        {section === "po" ? (
          <div className="section">
            <div className="section-head">
              <div className="spacer" />
              <span className="tag">
                {projectDocs.filter((d) => d.document_type === "PO").length} total
              </span>
            </div>
            <PurchaseOrdersSection docs={projectDocs} />
          </div>
        ) : null}

        {section === "quotes" ? (
          <div className="section">
            <QuoteAnalysisSection
              project={project}
              materials={materials}
              uploading={quoteUploading}
              setUploading={setQuoteUploading}
            />
          </div>
        ) : null}
      </div>

      {docsOpen ? (
        <Modal
          title="Documents"
          subtitle={`${projectDocs.length} in this project`}
          wide
          maxWidth="1240px"
          onClose={() => setDocsOpen(false)}
        >
          <DocumentsSection
            docs={projectDocs}
            onOpenDocument={onOpenDocument}
            emptyLabel="No documents in this project yet."
            bulkActions
            reload={reload}
            onProcessed={onProcessed}
          />
        </Modal>
      ) : null}

      {confirmingDelete ? (
        <Modal
          title="Delete project"
          subtitle={project.code}
          closable={!deleting}
          onClose={() => setConfirmingDelete(false)}
          footer={
            <>
              <div className="spacer" />
              <button
                className="btn btn-out"
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button className="btn btn-signal" type="button" onClick={deleteProject} disabled={deleting}>
                {deleting ? "Deleting…" : "Delete project"}
              </button>
            </>
          }
        >
          <p>
            Delete {project.code} and everything under it — every document, invoice, PO and
            quotation? This can't be undone.
          </p>
          {deleteErr ? <div className="banner banner-err">{deleteErr}</div> : null}
        </Modal>
      ) : null}

      {materialsOpen ? (
        <Modal
          title="Materials"
          subtitle={`from ${counted.length} document${counted.length === 1 ? "" : "s"}${rejectedInView ? ` · ${rejectedInView} rejected excluded` : ""}`}
          wide
          onClose={() => setMaterialsOpen(false)}
        >
          <MaterialsRollup docs={counted} materials={materials} />
        </Modal>
      ) : null}
    </div>
  );
}
