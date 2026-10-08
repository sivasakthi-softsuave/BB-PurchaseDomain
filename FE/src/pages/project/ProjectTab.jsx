import { ProjectGrid } from "./ProjectGrid.jsx";
import { ProjectDetail } from "./ProjectDetail.jsx";

/* #/project shows the grid, #/project/<id> the detail page — so a project is
   a real, linkable location with a working back button. */
export function ProjectTab({
  projectId, projects, docs, materials, reload,
  onOpenDocument, onAddProject, onAddDocument, onScan, onProcessed,
}) {
  if (!projectId) {
    return (
      <ProjectGrid
        projects={projects}
        docs={docs}
        onAddProject={onAddProject}
        onAddDocument={onAddDocument}
        onScan={onScan}
      />
    );
  }

  const project = projects.find((p) => p.id === projectId);

  /* A deep link can land before the project list has arrived — which is not
     the same as an id that does not exist. */
  if (!project) {
    return (
      <div className="band">
        <div className="col">
          <div className="empty">
            {projects.length ? "That project no longer exists." : "Loading…"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <ProjectDetail
      key={project.id}
      project={project}
      docs={docs}
      materials={materials}
      reload={reload}
      onOpenDocument={onOpenDocument}
      onAddDocument={onAddDocument}
      onScan={onScan}
      onProcessed={onProcessed}
    />
  );
}
