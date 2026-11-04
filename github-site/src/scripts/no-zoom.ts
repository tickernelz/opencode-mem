/** Block pinch / ctrl-wheel / keyboard zoom as far as browsers allow. */
export function installNoZoom(): void {
  const block = (event: Event) => event.preventDefault();

  for (const type of ["gesturestart", "gesturechange", "gestureend"] as const) {
    document.addEventListener(type, block, { passive: false });
  }

  document.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length > 1) event.preventDefault();
    },
    { passive: false }
  );

  document.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey) event.preventDefault();
    },
    { passive: false }
  );

  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === "+" || event.key === "-" || event.key === "=" || event.key === "0") {
      event.preventDefault();
    }
  });
}
