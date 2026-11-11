"use client";

import { switchProjectAction } from "@/app/actions/story";

export function ProjectSwitcher({ current, options }: { current: string | null; options: { key: string; name: string; role: string | null }[] }) {
  return (
    <form action={switchProjectAction} className="projswitch">
      <label htmlFor="project-switch">Dự án</label>
      <select id="project-switch" name="project" defaultValue={current ?? ""} onChange={(e) => e.currentTarget.form?.requestSubmit()}>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.key} · {o.name}
            {o.role ? "" : " (chỉ xem)"}
          </option>
        ))}
      </select>
      <noscript>
        <button className="btn sm" type="submit">
          Chọn
        </button>
      </noscript>
    </form>
  );
}
