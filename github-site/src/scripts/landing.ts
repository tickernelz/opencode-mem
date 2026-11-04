function lazyFields(): void {
  const fields = document.querySelectorAll<HTMLElement>("[data-field]");
  if (fields.length === 0 || !("IntersectionObserver" in window)) return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        import("./memory-field").then(({ mount }) => mount(entry.target as HTMLElement));
      }
    },
    { rootMargin: "240px 0px" }
  );
  fields.forEach((field) => observer.observe(field));
}

function tabs(): void {
  document.querySelectorAll<HTMLElement>("[data-tabs]").forEach((list) => {
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const select = (next: HTMLButtonElement, focus: boolean) => {
      for (const button of buttons) {
        const active = button === next;
        button.setAttribute("aria-selected", String(active));
        button.tabIndex = active ? 0 : -1;
        const panel = document.getElementById(button.getAttribute("aria-controls") ?? "");
        if (panel) panel.hidden = !active;
      }
      if (focus) next.focus();
    };
    buttons.forEach((button, index) => {
      button.addEventListener("click", () => select(button, false));
      button.addEventListener("keydown", (event) => {
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (step === 0) return;
        event.preventDefault();
        select(buttons[(index + step + buttons.length) % buttons.length]!, true);
      });
    });
  });
}

function copyButtons(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) => {
    const label = button.querySelector<HTMLElement>("[data-copy-label]");
    const original = label?.textContent ?? "";
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy ?? "");
        if (label) label.textContent = button.dataset.copied ?? original;
        window.setTimeout(() => label && (label.textContent = original), 1600);
      } catch {
        if (label) label.textContent = original;
      }
    });
  });
}

tabs();
copyButtons();
const idle =
  window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 200));
if (document.readyState === "complete") idle(lazyFields);
else window.addEventListener("load", () => idle(lazyFields), { once: true });
