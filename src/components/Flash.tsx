import { Icon } from "./Icon";

export function Flash({ ok, err }: { ok?: string | string[]; err?: string | string[] }) {
  const o = Array.isArray(ok) ? ok[0] : ok;
  const e = Array.isArray(err) ? err[0] : err;
  if (!o && !e) return null;
  return (
    <div className={`flash ${e ? "err" : "ok"}`} role={e ? "alert" : "status"}>
      <Icon name={e ? "alert" : "check"} size={17} />
      <span>{e ?? o}</span>
    </div>
  );
}
