"use client";

import { useId, useState } from "react";
import { Icon } from "./Icon";

/** Styled, Vietnamese file picker (the native control's text follows the browser language). */
export function FilePicker({ name = "files", id, label = "Đính kèm ảnh/video" }: { name?: string; id?: string; label?: string }) {
  const auto = useId();
  const inputId = id ?? auto;
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <span className="filepick">
      <input
        id={inputId}
        type="file"
        name={name}
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,video/quicktime"
        onChange={(e) => setPicked(Array.from(e.currentTarget.files ?? []).map((f) => f.name))}
      />
      <label htmlFor={inputId} className="btn sm">
        <Icon name="upload" size={15} /> {label}
      </label>
      <span className="small muted" title={picked.join(", ")}>
        {picked.length === 0 ? "Chưa chọn file" : picked.length === 1 ? picked[0] : `${picked.length} file đã chọn`}
      </span>
    </span>
  );
}
