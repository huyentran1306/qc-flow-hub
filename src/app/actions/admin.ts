"use server";

import { actorFor } from "@/lib/session";
import { runAndReturn } from "@/lib/flash";
import { saveConnection, checkConnection, CONNECTION_FIELDS } from "@/lib/services/connections";
import { createProject, parseProjectForm, updateProject } from "@/lib/services/projects";
import { createUser, resetPassword, setAdmin, setDisabled, setMembership } from "@/lib/services/users";
import { saveAccountsFromForm } from "@/lib/services/testAccounts";
import { ROLES, type ConnectionKind, type Role } from "@/lib/db/schema";

// Derived from the field map so a new connection kind can never be forgotten here.
const KINDS = Object.keys(CONNECTION_FIELDS) as ConnectionKind[];

export async function saveConnectionAction(fd: FormData) {
  const kind = String(fd.get("kind")) as ConnectionKind;
  await runAndReturn(`/admin/connections#${kind}`, async () => {
    if (!KINDS.includes(kind)) throw new Error("Loại kết nối không hợp lệ.");
    const { db, user } = await actorFor("admin.connections");
    const config = Object.fromEntries(CONNECTION_FIELDS[kind].config.map((k) => [k, String(fd.get(k) ?? "")]));
    const secret = String(fd.get("secret") ?? "");
    await saveConnection(db, user.id, kind, config, secret || undefined);
    if (fd.get("check") === "1") {
      const r = await checkConnection(db, user.id, kind);
      if (!r.ok) throw new Error(`Đã lưu, nhưng kiểm tra lỗi: ${r.message}`);
      return `Đã lưu. ${r.message}.`;
    }
    return "Đã lưu kết nối.";
  });
}

export async function checkConnectionAction(fd: FormData) {
  const kind = String(fd.get("kind")) as ConnectionKind;
  await runAndReturn(`/admin/connections#${kind}`, async () => {
    if (!KINDS.includes(kind)) throw new Error("Loại kết nối không hợp lệ.");
    const { db, user } = await actorFor("admin.connections");
    const r = await checkConnection(db, user.id, kind);
    if (!r.ok) throw new Error(r.message);
    return r.message;
  });
}

export async function createProjectAction(fd: FormData) {
  await runAndReturn("/admin/projects", async () => {
    const { db, user } = await actorFor("admin.projects");
    const input = parseProjectForm(fd);
    const id = await createProject(db, user.id, input);
    const myRole = String(fd.get("myRole") ?? "");
    if ((ROLES as readonly string[]).includes(myRole)) await setMembership(db, user.id, user.id, id, myRole as Role);
    return `Đã tạo dự án ${input.key}.`;
  });
}

export async function updateProjectAction(fd: FormData) {
  await runAndReturn("/admin/projects", async () => {
    const { db, user } = await actorFor("admin.projects");
    const input = parseProjectForm(fd);
    await updateProject(db, user.id, String(fd.get("id")), input);
    await saveAccountsFromForm(db, user.id, String(fd.get("id")), fd);
    return `Đã lưu dự án ${input.key}.`;
  });
}

export async function inviteUserAction(fd: FormData) {
  await runAndReturn("/admin/users", async () => {
    const { db, user } = await actorFor("admin.users");
    const email = String(fd.get("email") ?? "");
    const newId = await createUser(db, user.id, {
      email,
      name: String(fd.get("name") ?? ""),
      password: String(fd.get("password") ?? ""),
      isAdmin: fd.get("isAdmin") === "on",
    });
    const projectId = String(fd.get("projectId") ?? "");
    const role = String(fd.get("role") ?? "");
    if (projectId && (ROLES as readonly string[]).includes(role)) await setMembership(db, user.id, newId, projectId, role as Role);
    return `Đã tạo tài khoản ${email}. Gửi mật khẩu tạm cho người đó qua kênh riêng.`;
  });
}

export async function setRoleAction(fd: FormData) {
  await runAndReturn("/admin/users", async () => {
    const { db, user } = await actorFor("admin.users");
    const role = String(fd.get("role") ?? "");
    await setMembership(db, user.id, String(fd.get("userId")), String(fd.get("projectId")), (ROLES as readonly string[]).includes(role) ? (role as Role) : null);
    return "Đã cập nhật vai trò.";
  });
}

export async function toggleAdminAction(fd: FormData) {
  await runAndReturn("/admin/users", async () => {
    const { db, user } = await actorFor("admin.users");
    await setAdmin(db, user.id, String(fd.get("userId")), fd.get("value") === "1");
    return "Đã cập nhật quyền Admin.";
  });
}

export async function resetPasswordAction(fd: FormData) {
  await runAndReturn("/admin/users", async () => {
    const { db, user } = await actorFor("admin.users");
    const target = String(fd.get("userId"));
    if (target === user.id) throw new Error("Đổi mật khẩu của chính bạn ở màn Hồ sơ.");
    await resetPassword(db, user.id, target, String(fd.get("password") ?? ""));
    return "Đã đặt mật khẩu tạm. Gửi cho người đó qua kênh riêng và nhắc đổi lại ở Hồ sơ.";
  });
}

export async function toggleDisabledAction(fd: FormData) {
  await runAndReturn("/admin/users", async () => {
    const { db, user } = await actorFor("admin.users");
    await setDisabled(db, user.id, String(fd.get("userId")), fd.get("value") === "1");
    return "Đã cập nhật trạng thái tài khoản.";
  });
}
