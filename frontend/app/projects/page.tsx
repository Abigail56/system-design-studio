import AppShell from "@/components/layout/AppShell";
import { ProjectList } from "@/components/projects/ProjectList";
import { CreateProjectForm } from "@/components/projects/CreateProjectForm";
import { DashboardWelcome } from "@/components/projects/DashboardWelcome";
import { apiPaths, ApiError } from "@/lib/api-client";
import { apiFetch } from "@/lib/api-server";
import type { Project } from "@/lib/types";
import { redirect } from "next/navigation";

/**
 * Authenticated landing page. Data comes from the FastAPI backend, which is
 * the sole owner of the database schema.
 */
export default async function ProjectsPage() {
  let projects: Project[];

  try {
    const response = await apiFetch<{ projects: Project[] }>(apiPaths.projects);
    projects = response.projects;
  } catch (error) {
    // An expired Clerk session should land on sign-in, not a crash.
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    throw error;
  }

  return (
    <AppShell dashboard>
      <div className="dashboard-page min-h-full">
        <div className="mx-auto w-full max-w-6xl px-6 pb-16 pt-14 sm:px-8 sm:pb-20 sm:pt-20">
          <div className="mb-14 flex flex-wrap items-end justify-between gap-8">
            <DashboardWelcome />
            <CreateProjectForm />
          </div>

          <div className="mb-5 flex items-center justify-between border-b border-[var(--border)] pb-3">
            <h2 className="text-sm font-semibold tracking-tight">Your workspaces</h2>
            <span className="text-xs text-[var(--fg-subtle)]">
              {projects.length} {projects.length === 1 ? "workspace" : "workspaces"}
            </span>
          </div>
          <ProjectList projects={projects} />
        </div>
      </div>
    </AppShell>
  );
}