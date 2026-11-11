"use client";

/** Quick-select buttons for the checkboxes of a form (by data attributes on the inputs). */
export function CheckHelper({ formId }: { formId: string }) {
  const set = (pred: (el: HTMLInputElement) => boolean | null) => {
    const form = document.getElementById(formId);
    form?.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="tcId"]').forEach((el) => {
      const v = pred(el);
      if (v !== null) el.checked = v;
    });
  };
  return (
    <span className="actions">
      <button type="button" className="btn sm" onClick={() => set((el) => (el.dataset.type === "happy" ? true : null))}>
        Chọn mọi happy case
      </button>
      <button type="button" className="btn sm" onClick={() => set((el) => (el.dataset.kind === "api" ? true : null))}>
        Chọn mọi TC API
      </button>
      <button type="button" className="btn sm" onClick={() => set(() => true)}>
        Chọn tất cả
      </button>
      <button type="button" className="btn sm" onClick={() => set(() => false)}>
        Bỏ chọn
      </button>
    </span>
  );
}
