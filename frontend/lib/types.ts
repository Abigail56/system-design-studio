/**
 * Types mirroring the FastAPI schemas in `api/app/schemas.py`.
 *
 * The backend is the source of truth; this file is a hand-maintained mirror.
 * When a route changes, regenerate from the OpenAPI schema at
 * `GET /v1/openapi.json` rather than editing by hand.
 */

export const ROLES = ["OWNER", "EDITOR", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

export type UserBrief = {
  id: string;
  name: string | null;
  email: string;
  image_url: string | null;
};

export type ProjectMember = {
  id: string;
  role: Role;
  created_at: string;
  user: UserBrief;
};

export type Project = {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
  role: Role;
  member_count: number;
  snapshot_count: number;
};

export type ProjectDetail = Project & {
  owner: UserBrief;
  members: ProjectMember[];
};

export type ProjectInvite = {
  id: string;
  email: string;
  role: Role;
  created_at: string;
};

export type Snapshot = {
  id: string;
  project_id: string;
  /** null for inline snapshots, which carry their payload in Postgres. */
  blob_url: string | null;
  /** "blob" or "inline". */
  storage: string;
  created_at: string;
  created_by: UserBrief;
};

export type AITaskStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
export type AITaskType = "GENERATE_DESIGN" | "GENERATE_SPEC";

export type AITask = {
  id: string;
  project_id: string;
  type: AITaskType;
  status: AITaskStatus;
  prompt: string;
  result: Record<string, unknown> | null;
  error: string | null;
  triggerdev_id: string | null;
  created_at: string;
  completed_at: string | null;
};

/** Coarse shape for the project card grid. */
export type ProjectSummary = Project;

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;

  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}