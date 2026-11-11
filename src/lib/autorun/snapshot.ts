export type PageElement = {
  ref: string;
  tag: string;
  type?: string;
  text?: string;
  placeholder?: string;
  label?: string;
  name?: string;
  disabled?: boolean;
};
export type PageSnapshot = { url: string; title: string; elements: PageElement[]; text: string };

/** Runs inside the page: tags visible interactive elements with data-qfh-ref and returns a compact view. */
export function collectSnapshot(): PageSnapshot {
  document.querySelectorAll("[data-qfh-ref]").forEach((e) => e.removeAttribute("data-qfh-ref"));
  const out: PageElement[] = [];
  const nodes = document.querySelectorAll<HTMLElement>(
    'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="menuitem"],[onclick]',
  );
  let n = 0;
  for (const el of Array.from(nodes)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || st.visibility === "hidden" || st.display === "none") continue;
    const ref = `e${++n}`;
    el.setAttribute("data-qfh-ref", ref);
    const input = el as HTMLInputElement;
    out.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: input.type || undefined,
      text: (el.innerText || input.value || "").trim().replace(/\s+/g, " ").slice(0, 80) || undefined,
      placeholder: input.placeholder || undefined,
      label: el.getAttribute("aria-label") || el.getAttribute("title") || undefined,
      name: input.name || undefined,
      disabled: input.disabled || undefined,
    });
    if (out.length >= 150) break;
  }
  return { url: location.href, title: document.title, elements: out, text: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 3500) };
}
