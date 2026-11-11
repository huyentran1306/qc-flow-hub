import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../db";
import { memberships, projects, defaultMapping, defaultBugStatusMap, type ProjectMapping, type Role, type BugStatusMap, type Env } from "../db/schema";
import { audit } from "../audit";

export type ProjectInput = {
  key: string;
  name: string;
  jiraBoardId: number | null;
  testlinkProjectName: string | null;
  mapping: ProjectMapping;
  bugStatusMap?: BugStatusMap;
  envUrls?: Partial<Record<Env, string>>;
};

export function parseProjectForm(fd: FormData): ProjectInput {
  const key = String(fd.get("key") ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(key)) throw new Error("Mã dự án phải là mã project trên Jira, ví dụ OP.");
  const name = String(fd.get("name") ?? "").trim();
  if (!name) throw new Error("Cần nhập tên dự án.");
  const board = String(fd.get("jiraBoardId") ?? "").trim();
  if (board && !/^\d+$/.test(board)) throw new Error("Board id là số, xem trên URL board Jira (rapidView=…).");
  const text = (k: string, d = "") => String(fd.get(k) ?? d).trim();
  const list = (k: string, d: string[]) => {
    const v = text(k).split(",").map((x) => x.trim()).filter(Boolean);
    return v.length ? v : d;
  };
  const url = (k: string) => {
    const v = text(k);
    if (v && !/^https?:\/\//.test(v)) throw new Error(`URL môi trường phải bắt đầu bằng http:// hoặc https:// (${v}).`);
    return v || undefined;
  };
  return {
    key,
    name,
    jiraBoardId: board ? Number(board) : null,
    testlinkProjectName: text("testlinkProjectName") || null,
    mapping: {
      storyIssueType: text("storyIssueType") || defaultMapping.storyIssueType,
      subBugIssueType: text("subBugIssueType") || defaultMapping.subBugIssueType,
      qcSubtaskLabel: text("qcSubtaskLabel") || defaultMapping.qcSubtaskLabel,
      severityField: text("severityField") || undefined,
      environmentField: text("environmentField") || undefined,
    },
    bugStatusMap: {
      resolved: list("statusResolved", defaultBugStatusMap.resolved),
      closed: list("statusClosed", defaultBugStatusMap.closed),
      reopened: list("statusReopened", defaultBugStatusMap.reopened),
    },
    envUrls: { dev: url("urlDev"), stg: url("urlStg"), prod: url("urlProd") },
  };
}

export async function createProject(db: DB, actorId: string, input: ProjectInput): Promise<string> {
  const [exists] = await db.select({ id: projects.id }).from(projects).where(eq(projects.key, input.key));
  if (exists) throw new Error(`Dự án ${input.key} đã tồn tại.`);
  const [p] = await db.insert(projects).values(input).returning({ id: projects.id });
  await audit(db, { userId: actorId, action: "Tạo dự án", target: input.key });
  return p.id;
}

export async function updateProject(db: DB, actorId: string, id: string, input: ProjectInput): Promise<void> {
  const { key: _key, ...rest } = input; // the key is the Jira project key and stays fixed
  void _key;
  await db.update(projects).set(rest).where(eq(projects.id, id));
  await audit(db, { userId: actorId, action: "Cập nhật dự án và ánh xạ", target: input.key });
}

export type ProjectContext = {
  project: typeof projects.$inferSelect | null;
  role: Role | null;
  available: { key: string; name: string; role: Role | null }[];
};

/** Projects the user can open (admins see all) and the one currently selected. */
export async function projectContext(db: DB, user: { id: string; isAdmin: boolean }, preferredKey?: string | null): Promise<ProjectContext> {
  const ms = await db.select().from(memberships).where(eq(memberships.userId, user.id));
  const roleOf = new Map(ms.map((m) => [m.projectId, m.role]));
  const list = user.isAdmin
    ? await db.select().from(projects).orderBy(projects.key)
    : ms.length
      ? await db.select().from(projects).where(inArray(projects.id, [...roleOf.keys()])).orderBy(projects.key)
      : [];
  const project = list.find((p) => p.key === preferredKey) ?? list[0] ?? null;
  return {
    project,
    role: project ? (roleOf.get(project.id) ?? null) : null,
    available: list.map((p) => ({ key: p.key, name: p.name, role: roleOf.get(p.id) ?? null })),
  };
}

export async function roleIn(db: DB, userId: string, projectId: string): Promise<Role | null> {
  const [m] = await db.select().from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.projectId, projectId)));
  return m?.role ?? null;
}
