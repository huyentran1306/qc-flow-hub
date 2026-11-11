"use client";

import { useState } from "react";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState<null | "ok" | "fail">(null);
  return (
    <button
      type="button"
      className="btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone("ok");
        } catch {
          setDone("fail");
        }
        setTimeout(() => setDone(null), 2000);
      }}
    >
      {done === "ok" ? "Đã copy" : done === "fail" ? "Trình duyệt chặn copy" : label}
    </button>
  );
}
