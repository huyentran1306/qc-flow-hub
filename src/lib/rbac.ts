import type { Role } from "./db/schema";

export type Perm =
  | "story.view"
  | "jira.sync"
  | "ai.run"
  | "qna.manage"
  | "qna.answer"
  | "tc.edit"
  | "tc.approve"
  | "testlink.push"
  | "audit.view";

export type AdminPerm = "admin.connections" | "admin.users" | "admin.projects";

/** Per-project permissions by role. Mirrors the matrix in the design doc. */
const ROLE_PERMS: Record<Role, Perm[]> = {
  lead: ["story.view", "jira.sync", "ai.run", "qna.manage", "qna.answer", "tc.edit", "tc.approve", "testlink.push"],
  qc: ["story.view", "jira.sync", "ai.run", "qna.manage", "qna.answer", "tc.edit", "tc.approve", "testlink.push"],
  dev: ["story.view"],
  po: ["story.view", "qna.answer"],
};

/** A system admin manages settings and can see project data, but does not do QC work
 *  unless they are also given a project role. */
const ADMIN_PROJECT_PERMS: Perm[] = ["story.view", "jira.sync", "audit.view"];

export const ROLE_LABEL: Record<Role, string> = { lead: "QC Lead", qc: "QC", dev: "Dev", po: "PO / BA" };

export type Actor = { isAdmin: boolean; role: Role | null };

export function can(actor: Actor, perm: Perm | AdminPerm): boolean {
  if (perm.startsWith("admin.")) return actor.isAdmin;
  const p = perm as Perm;
  if (actor.role && ROLE_PERMS[actor.role].includes(p)) return true;
  return actor.isAdmin && ADMIN_PROJECT_PERMS.includes(p);
}

export class ForbiddenError extends Error {
  constructor(perm: string) {
    super(`Bạn không có quyền thực hiện thao tác này (${perm}).`);
  }
}

export function assertCan(actor: Actor, perm: Perm | AdminPerm): void {
  if (!can(actor, perm)) throw new ForbiddenError(perm);
}
