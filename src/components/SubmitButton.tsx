"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({
  children,
  pendingText = "Đang xử lý…",
  className = "btn",
  name,
  value,
  title,
}: {
  children: React.ReactNode;
  pendingText?: string;
  className?: string;
  name?: string;
  value?: string;
  title?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} name={name} value={value} title={title} aria-busy={pending}>
      {pending ? pendingText : children}
    </button>
  );
}
