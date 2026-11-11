import { redirect } from "next/navigation";

export function withFlash(path: string, flash: { ok?: string; err?: string }): string {
  const url = new URL(path, "http://x");
  url.searchParams.delete("ok");
  url.searchParams.delete("err");
  if (flash.ok) url.searchParams.set("ok", flash.ok);
  if (flash.err) url.searchParams.set("err", flash.err);
  return url.pathname + url.search + url.hash;
}

/** Runs a mutation, then redirects back to `path` with a success or error message.
 *  `path` may be a function, evaluated after the mutation (e.g. to open the record it created). */
export async function runAndReturn(path: string | (() => string), fn: () => Promise<string | void>): Promise<never> {
  let ok: string | undefined;
  let err: string | undefined;
  try {
    ok = (await fn()) || undefined;
  } catch (e) {
    err = (e as Error).message || "Có lỗi xảy ra.";
    console.error(`[action]`, e);
  }
  redirect(withFlash(typeof path === "function" ? path() : path, { ok, err }));
}
