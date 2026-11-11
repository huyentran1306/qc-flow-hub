"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { createFirstAdmin, verifyLogin, changePassword } from "@/lib/services/users";
import { endSession, startSession, currentUser } from "@/lib/session";
import { withFlash, runAndReturn } from "@/lib/flash";
import { audit } from "@/lib/audit";

export async function loginAction(fd: FormData) {
  const db = await getDb();
  const u = await verifyLogin(db, String(fd.get("email") ?? ""), String(fd.get("password") ?? ""));
  if (!u) redirect(withFlash("/login", { err: "Email hoặc mật khẩu không đúng." }));
  await startSession(u.id);
  await audit(db, { userId: u.id, action: "Đăng nhập" });
  redirect("/board");
}

export async function setupAction(fd: FormData) {
  const db = await getDb();
  let userId: string;
  try {
    userId = await createFirstAdmin(db, {
      email: String(fd.get("email") ?? ""),
      name: String(fd.get("name") ?? ""),
      password: String(fd.get("password") ?? ""),
    });
  } catch (e) {
    redirect(withFlash("/setup", { err: (e as Error).message }));
  }
  await startSession(userId);
  redirect(withFlash("/admin/setup", { ok: "Đã tạo tài khoản Admin." }));
}

export async function logoutAction() {
  await endSession();
  redirect("/login");
}

export async function changePasswordAction(fd: FormData) {
  await runAndReturn("/profile", async () => {
    const u = await currentUser();
    if (!u) throw new Error("Phiên đăng nhập đã hết.");
    if (fd.get("next") !== fd.get("confirm")) throw new Error("Hai lần nhập mật khẩu mới không khớp.");
    await changePassword(await getDb(), u.id, String(fd.get("current") ?? ""), String(fd.get("next") ?? ""));
    await startSession(u.id); // keep this browser signed in with the new session version
    return "Đã đổi mật khẩu. Các phiên đăng nhập khác đã bị đăng xuất.";
  });
}
