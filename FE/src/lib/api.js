/* Every call to the backend lives here, so a route change is a one-file edit
   and no component has a URL baked into it. */

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail ?? `Server returned ${res.status}`);
  return body;
}

const get = (path) => fetch(path).then(json);

const send = (path, method, body) =>
  fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(json);

export const api = {
  /* The LAN address a phone has to reach — only the server knows its own. */
  config: () => get("/api/v1/config"),

  listProjects: () => get("/api/v1/projects").then((d) => d.projects ?? []),
  createProject: (name) => send("/api/v1/projects", "POST", { name }),
  deleteProject: (id) => fetch(`/api/v1/projects/${id}`, { method: "DELETE" }).then(json),

  listDocuments: (filters) => {
    const qs = filters ? `?${new URLSearchParams(filters).toString()}` : "";
    return get(`/api/v1/documents${qs}`).then((d) => d.documents ?? []);
  },
  getDocument: (id) => get(`/api/v1/documents/${id}`),
  saveDocument: (id, edits) => send(`/api/v1/documents/${id}`, "PUT", edits),
  deleteDocument: (id) => fetch(`/api/v1/documents/${id}`, { method: "DELETE" }).then(json),
  approveDocument: (id, approvedBy) =>
    send(`/api/v1/documents/${id}/approve`, "POST", { approved_by: approvedBy }),
  rejectDocument: (id, rejectedBy, reason) =>
    send(`/api/v1/documents/${id}/reject`, "POST", { rejected_by: rejectedBy, reason }),
  retryExtraction: (id) => fetch(`/api/v1/documents/${id}/extract`, { method: "POST" }),
  /* The console's Process/Draft choice for a batch just scanned in from the
     phone (see process_batch / draft_batch in Backend/main.py) — both clear
     awaiting_scan_decision so the batch stops being hidden; Process also
     queues extraction, Draft leaves it sitting at PENDING in Documents. */
  processDocuments: (documentIds) =>
    send("/api/v1/documents/process-batch", "POST", { document_ids: documentIds }),
  draftDocuments: (documentIds) =>
    send("/api/v1/documents/draft-batch", "POST", { document_ids: documentIds }),

  /* Same delivery billed twice through two channels (site copy, office
     copy) — found automatically by vendor + invoice number at extraction
     time. duplicate_of is null in the response when this document has no
     paired copy on file (yet). */
  getDuplicateDiff: (id) => get(`/api/v1/documents/${id}/duplicate-diff`),
  /* Per-material disagreements between this document and the others in its
     own delivery, so the review screen can show each one against the line it
     concerns. {} when there's nothing to compare against. */
  getLineIssues: (id) => get(`/api/v1/documents/${id}/line-issues`).then((d) => d.issues ?? {}),
  /* Only meaningful for a PO document: every invoice referencing it,
     grouped into deliveries, and the running delivered-vs-ordered total
     per material. */
  getPoReconciliation: (id) => get(`/api/v1/documents/${id}/reconciliation`),
  /* Builds a Purchase Bill from an already-matched Invoice + MIN Voucher
     pair — base is "invoice" or "min", which document's own values (vendor,
     tax figures, line items) the new record is built from. */
  generatePurchaseBill: (invoiceDocumentId, inwardDocumentId, base) =>
    send("/api/v1/deliveries/generate-purchase-bill", "POST",
      { invoice_document_id: invoiceDocumentId, inward_document_id: inwardDocumentId, base }),

  listMaterials: () => get("/api/v1/materials").then((d) => d.materials ?? []),

  /* Read-only question answering. Stateless on the server — prior turns are
     replayed from here, so there is no conversation to lose or to clean up. */
  ask: (question, history) => send("/api/v1/chat", "POST", { question, history }),

  /* The QR ships with the session, so picking a project no longer costs a
     page reload. */
  createSession: (projectId) =>
    send("/api/v1/sessions", "POST", { project_id: projectId, created_by: "web" }),

  /* Multipart, so it does not go through send(). One file is one document —
     no document-type hint from the console; the classifier's own read of the
     pixels is what decides what gets stored. */
  uploadFiles: ({ projectId, siteId, files }) => {
    const form = new FormData();
    form.append("project_id", projectId);
    if (siteId) form.append("site_id", siteId);
    files.forEach((f) => form.append("files", f, f.name));
    return fetch("/api/v1/documents/upload", { method: "POST", body: form }).then(json);
  },

  /* Quote analysis — a vendor's price quotation, not a purchase document, so
     it lives on its own small set of endpoints rather than /documents. */
  listQuotations: (projectId) =>
    get(`/api/v1/projects/${projectId}/quotations`).then((d) => d.quotations ?? []),
  getQuotation: (id) => get(`/api/v1/quotations/${id}`),
  uploadQuotation: ({ projectId, files }) => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f, f.name));
    return fetch(`/api/v1/projects/${projectId}/quotations`, { method: "POST", body: form }).then(json);
  },
  saveQuotation: (id, edits) => send(`/api/v1/quotations/${id}`, "PUT", edits),
  retryQuotationExtraction: (id) => fetch(`/api/v1/quotations/${id}/extract`, { method: "POST" }),
  deleteQuotation: (id) => fetch(`/api/v1/quotations/${id}`, { method: "DELETE" }).then(json),

  /* Which vendor to actually buy each material from — cheapest by default,
     overridable per material since grade/quality isn't a number the app can
     rank on its own. */
  listQuotePicks: (projectId) =>
    get(`/api/v1/projects/${projectId}/quote-picks`).then((d) => d.picks ?? {}),
  setQuotePick: (projectId, materialId, quotationId, pickedBy) =>
    send(`/api/v1/projects/${projectId}/quote-picks/${materialId}`, "PUT",
      { quotation_id: quotationId, picked_by: pickedBy }),
  clearQuotePick: (projectId, materialId) =>
    fetch(`/api/v1/projects/${projectId}/quote-picks/${materialId}`, { method: "DELETE" }).then(json),
};
