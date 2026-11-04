import {
  captureGraph,
  dreamGraph,
  heroGraph,
  type MemoryGraph,
  type MemoryNode,
} from "../lib/constellation";

interface Palette {
  fg: string;
  muted: string;
  primary: string;
  bright: string;
  warning: string;
  bg: string;
}

const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

function readPalette(element: Element): Palette {
  const style = getComputedStyle(element);
  const v = (name: string) => style.getPropertyValue(name).trim();
  return {
    fg: v("--om-foreground"),
    muted: v("--om-muted-foreground"),
    primary: v("--om-primary"),
    bright: v("--om-chart-3"),
    warning: v("--om-warning"),
    bg: v("--om-background"),
  };
}

const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 4);

class Field {
  readonly ctx: CanvasRenderingContext2D;
  readonly nodes: MemoryNode[];
  readonly edges: Array<[number, number]>;
  energy: Float32Array;
  born: number[] = [];
  palette: Palette;
  width = 0;
  height = 0;
  scale = 1;
  offsetX = 0;
  offsetY = 0;
  drift = 0;
  dim = 1;
  pointer: { x: number; y: number } | null = null;
  queue: Array<{ i: number; at: number; s: number }> = [];
  visible = false;
  frameId = 0;
  last = 0;
  onTick: ((now: number, dt: number) => void) | null = null;
  decorate: ((ctx: CanvasRenderingContext2D) => void) | null = null;
  nodeAlpha: ((i: number) => number) | null = null;
  nodeScale: ((i: number) => number) | null = null;
  nodePosition: ((i: number) => [number, number] | null) | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly graph: MemoryGraph
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d unavailable");
    this.ctx = ctx;
    this.palette = readPalette(canvas);
    this.nodes = graph.nodes.map((node) => ({ ...node }));
    this.edges = graph.edges.map(([a, b]) => [a, b]);
    this.energy = new Float32Array(this.nodes.length + 16);
    this.resize();
    new ResizeObserver(() => {
      this.resize();
      this.draw();
    }).observe(canvas);
    new IntersectionObserver(([entry]) => {
      this.visible = Boolean(entry?.isIntersecting);
      if (this.visible) this.start();
    }).observe(canvas);
    new MutationObserver(() => {
      this.palette = readPalette(this.canvas);
      this.draw();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  get still(): boolean {
    return motion.matches;
  }

  fit: "cover" | "contain" = "cover";

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pick = this.fit === "cover" ? Math.max : Math.min;
    this.scale = pick(this.width / this.graph.width, this.height / this.graph.height);
    this.offsetX = (this.width - this.graph.width * this.scale) / 2;
    this.offsetY = (this.height - this.graph.height * this.scale) / 2;
  }

  point(i: number): [number, number] {
    const custom = this.nodePosition?.(i);
    const node = this.nodes[i]!;
    const [x, y] = custom ?? [node.x, node.y];
    return [this.offsetX + x * this.scale, this.offsetY + y * this.scale - this.drift * node.z];
  }

  toGraph(x: number, y: number): [number, number] {
    return [(x - this.offsetX) / this.scale, (y - this.offsetY) / this.scale];
  }

  neighbors(i: number): number[] {
    const out: number[] = [];
    for (const [a, b] of this.edges) {
      if (a === i) out.push(b);
      else if (b === i) out.push(a);
    }
    return out;
  }

  pulse(i: number, strength = 1, spread = 2): void {
    const now = performance.now();
    const seen = new Set([i]);
    let ring = [i];
    for (let depth = 0; depth <= spread; depth++) {
      for (const n of ring)
        this.queue.push({ i: n, at: now + depth * 180, s: strength * Math.pow(0.55, depth) });
      const next: number[] = [];
      for (const n of ring)
        for (const m of this.neighbors(n)) {
          if (seen.has(m)) continue;
          seen.add(m);
          next.push(m);
        }
      ring = next;
    }
  }

  addNode(node: MemoryNode, links: number, reuse?: number): number {
    const index = reuse ?? this.nodes.push(node) - 1;
    if (reuse !== undefined) {
      this.nodes[index] = node;
      this.energy[index] = 0;
      for (let e = this.edges.length - 1; e >= 0; e--) {
        const [a, b] = this.edges[e]!;
        if (a === index || b === index) this.edges.splice(e, 1);
      }
    }
    if (this.energy.length < this.nodes.length) {
      const grown = new Float32Array(this.nodes.length + 16);
      grown.set(this.energy);
      this.energy = grown;
    }
    this.nodes
      .map((other, j) => ({ j, d: Math.hypot(other.x - node.x, other.y - node.y) }))
      .filter(({ j }) => j !== index && this.alphaOf(j) > 0.01)
      .sort((a, b) => a.d - b.d)
      .slice(0, links)
      .forEach(({ j }) => this.edges.push([index, j]));
    this.born[index] = performance.now();
    return index;
  }

  start(): void {
    if (this.still) {
      this.draw();
      return;
    }
    if (this.frameId) return;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.visible || document.hidden) {
        this.frameId = 0;
        return;
      }
      const dt = Math.min(64, now - this.last);
      this.last = now;
      this.step(now, dt);
      this.draw();
      this.frameId = requestAnimationFrame(loop);
    };
    this.frameId = requestAnimationFrame(loop);
  }

  step(now: number, dt: number): void {
    this.onTick?.(now, dt);
    const decay = Math.exp(-dt / 900);
    for (let i = 0; i < this.nodes.length; i++) this.energy[i]! *= decay;
    this.queue = this.queue.filter((item) => {
      if (item.at > now) return true;
      this.energy[item.i] = Math.max(this.energy[item.i]!, item.s);
      return false;
    });
    if (this.pointer) {
      for (let i = 0; i < this.nodes.length; i++) {
        const [x, y] = this.point(i);
        const d = Math.hypot(x - this.pointer.x, y - this.pointer.y);
        if (d < 120) this.energy[i] = Math.max(this.energy[i]!, 1 - d / 120);
      }
    }
  }

  draw(): void {
    const { ctx, palette } = this;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.lineWidth = 1;
    ctx.strokeStyle = palette.primary;
    for (const [a, b] of this.edges) {
      const visibility = Math.min(this.alphaOf(a), this.alphaOf(b));
      if (visibility <= 0.01) continue;
      const e = Math.max(this.energy[a]!, this.energy[b]!);
      ctx.globalAlpha = (0.2 + 0.55 * e) * visibility * this.dim;
      const [ax, ay] = this.point(a);
      const [bx, by] = this.point(b);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    const now = performance.now();
    ctx.font = `500 12px "JetBrains Mono Variable", ui-monospace, monospace`;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i]!;
      const alpha = this.alphaOf(i);
      if (alpha <= 0.01) continue;
      const e = this.energy[i]!;
      const birth = this.born[i] ? ease((now - this.born[i]!) / 700) : 1;
      const r = node.r * (0.7 + node.z * 0.5) * (1 + e * 0.7) * (this.nodeScale?.(i) ?? 1) * birth;
      const [x, y] = this.point(i);
      if (e > 0.05) {
        ctx.globalAlpha = 0.18 * e * alpha;
        ctx.fillStyle = palette.primary;
        ctx.beginPath();
        ctx.arc(x, y, r * 4.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = (0.45 + 0.55 * Math.max(e, node.z * 0.6)) * alpha * Math.max(this.dim, e);
      ctx.fillStyle = e > 0.5 ? palette.bright : palette.primary;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.8, r), 0, Math.PI * 2);
      ctx.fill();
      if (node.label && e > 0.35) {
        ctx.globalAlpha = Math.min(1, (e - 0.35) * 2.4) * alpha;
        ctx.fillStyle = palette.fg;
        const width = ctx.measureText(node.label).width;
        const left = x + 12 + width > this.width - 8 ? x - 12 - width : x + 12;
        ctx.fillText(node.label, left, y + 4);
      }
    }
    this.decorate?.(ctx);
    ctx.globalAlpha = 1;
  }

  alphaOf(i: number): number {
    return this.nodeAlpha?.(i) ?? 1;
  }
}

function hero(root: HTMLElement): void {
  const canvas = root.querySelector("canvas")!;
  const labels = JSON.parse(root.dataset.labels ?? "[]") as string[];
  const field = new Field(canvas, heroGraph(labels));
  const focus = field.nodes.findIndex((node) => node.label === labels[0]);
  const chat = document.querySelector<HTMLElement>("[data-recall]");
  const anchor = chat?.querySelector<HTMLElement>("[data-recall-anchor]");
  let thread = 0;
  let threadStart = 0;

  field.decorate = (ctx) => {
    if (!anchor || !thread || focus < 0) return;
    const box = canvas.getBoundingClientRect();
    const target = anchor.getBoundingClientRect();
    const [fx, fy] = field.point(focus);
    const tx = target.left - box.left;
    const ty = target.top - box.top + target.height / 2;
    const progress = field.still ? 1 : ease((performance.now() - threadStart) / 900);
    ctx.globalAlpha = 0.85 * thread;
    ctx.strokeStyle = field.palette.bright;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    const cx = (fx + tx) / 2;
    const steps = 24;
    for (let s = 1; s <= Math.round(steps * progress); s++) {
      const t = s / steps;
      const x = (1 - t) ** 2 * fx + 2 * (1 - t) * t * cx + t * t * tx;
      const y = (1 - t) ** 2 * fy + 2 * (1 - t) * t * Math.min(fy, ty) + t * t * ty;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  };

  const recall = () => {
    if (focus >= 0) {
      field.pulse(focus, 1, 3);
      field.energy[focus] = 1;
    }
    thread = 1;
    threadStart = performance.now();
    chat?.setAttribute("data-state", "recalled");
  };

  if (field.still) {
    if (focus >= 0) field.energy[focus] = 1;
    thread = 1;
    field.draw();
    return;
  }

  chat?.setAttribute("data-state", "pending");
  window.setTimeout(recall, 700);

  let ambient = 0;
  field.onTick = (now) => {
    field.drift = Math.min(window.scrollY, 900) * 0.12;
    if (focus >= 0 && thread) field.energy[focus] = Math.max(field.energy[focus]!, 0.75);
    if (now > ambient) {
      ambient = now + 2400;
      field.pulse(Math.floor(Math.random() * field.nodes.length), 0.8, 2);
    }
  };

  const area = root.closest<HTMLElement>("[data-pointer-area]") ?? root;
  area.addEventListener("pointermove", (event) => {
    const box = canvas.getBoundingClientRect();
    field.pointer = { x: event.clientX - box.left, y: event.clientY - box.top };
  });
  area.addEventListener("pointerleave", () => {
    field.pointer = null;
  });
  document.addEventListener("visibilitychange", () => !document.hidden && field.start());
  field.start();
}

function capture(root: HTMLElement): void {
  const canvas = root.querySelector("canvas")!;
  const field = new Field(canvas, captureGraph());
  field.fit = "contain";
  field.resize();
  const terminal = root.querySelector<HTMLElement>("[data-terminal]");
  const card = root.querySelector<HTMLElement>("[data-card]");
  const sessions = JSON.parse(root.dataset.sessions ?? "[]") as Array<{
    lines: Array<[string, string]>;
    memory: string;
    tag: string;
  }>;
  if (!terminal || !card || field.still || sessions.length === 0) {
    field.draw();
    return;
  }
  const lineTemplate = terminal.querySelector<HTMLElement>("[data-line]");
  const idle = terminal.querySelector<HTMLElement>("[data-idle]");
  const random = Math.random;
  let cycle = 0;
  const captured: number[] = [];
  const keep = 4;
  const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  const run = async () => {
    if (!field.visible) {
      window.setTimeout(run, 600);
      return;
    }
    const session = sessions[cycle % sessions.length]!;
    cycle++;
    terminal.querySelectorAll("[data-line]").forEach((line) => line.remove());
    idle?.setAttribute("data-on", "false");
    card.setAttribute("data-state", "hidden");
    for (const [who, text] of session.lines) {
      const line =
        (lineTemplate?.cloneNode(true) as HTMLElement | undefined) ?? document.createElement("p");
      line.querySelector("[data-who]")!.textContent = who;
      const target = line.querySelector<HTMLElement>("[data-text]")!;
      target.textContent = "";
      terminal.insertBefore(line, idle ?? null);
      for (let c = 1; c <= text.length; c += 2) {
        target.textContent = text.slice(0, c + 1);
        await wait(28);
      }
      await wait(320);
    }
    idle?.setAttribute("data-on", "true");
    await wait(500);
    card.querySelector("[data-memory]")!.textContent = session.memory;
    card.querySelector("[data-tag]")!.textContent = session.tag;
    card.setAttribute("data-state", "shown");
    await wait(1300);
    const cluster = Math.floor(random() * 3);
    const anchor = field.nodes.find((node) => node.cluster === cluster)!;
    const node: MemoryNode = {
      x: anchor.x + (random() - 0.5) * 120,
      y: anchor.y + (random() - 0.5) * 100,
      r: 4.2,
      z: 1,
      cluster,
    };
    const box = canvas.getBoundingClientRect();
    const from = card.getBoundingClientRect();
    const tx = box.left + field.offsetX + node.x * field.scale - (from.left + from.width / 2);
    const ty = box.top + field.offsetY + node.y * field.scale - (from.top + from.height / 2);
    await card.animate(
      [
        { transform: "translate(0, 0) scale(1)", opacity: 1 },
        { transform: `translate(${tx}px, ${ty}px) scale(0.06)`, opacity: 0.2 },
      ],
      { duration: 900, easing: "cubic-bezier(0.65, 0, 0.35, 1)" }
    ).finished;
    card.setAttribute("data-state", "hidden");
    const index = field.addNode(node, 3, captured.length >= keep ? captured.shift() : undefined);
    captured.push(index);
    field.pulse(index, 1, 2);
    await wait(2600);
    run();
  };

  document.addEventListener("visibilitychange", () => !document.hidden && field.start());
  field.start();
  window.setTimeout(run, 400);
}

function dream(root: HTMLElement): void {
  const canvas = root.querySelector("canvas")!;
  const field = new Field(canvas, dreamGraph());
  const groups: Array<{ keep: number; merge: number[] }> = [];
  const used = new Set<number>();
  field.nodes.forEach((node, i) => {
    if (used.has(i) || groups.length >= 6 || i % 3 !== 0) return;
    const near = field.nodes
      .map((other, j) => ({
        j,
        d:
          other.cluster === node.cluster
            ? Math.hypot(other.x - node.x, other.y - node.y)
            : Infinity,
      }))
      .filter(({ j, d }) => j !== i && !used.has(j) && d < 110)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .map(({ j }) => j);
    if (near.length < 2) return;
    used.add(i);
    near.forEach((j) => used.add(j));
    groups.push({ keep: i, merge: near });
  });
  const flagged = field.nodes
    .map((_, i) => i)
    .filter((i) => !used.has(i))
    .slice(0, 2);
  const target = new Map<number, number>();
  groups.forEach((group) => group.merge.forEach((j) => target.set(j, group.keep)));
  const legend = root.querySelectorAll<HTMLElement>("[data-legend]");
  const cycle = 12000;
  let phase = 1;

  const apply = (p: number) => {
    phase = p;
    const night = ease((p - 0.08) / 0.12);
    const merge = ease((p - 0.25) / 0.3);
    const fade = 1 - ease((p - 0.92) / 0.08);
    field.dim = 1 - 0.4 * night * fade;
    field.nodePosition = (i) => {
      const keep = target.get(i);
      if (keep === undefined || merge === 0) return null;
      const a = field.nodes[i]!;
      const b = field.nodes[keep]!;
      const m = merge * fade;
      return [a.x + (b.x - a.x) * m, a.y + (b.y - a.y) * m];
    };
    field.nodeAlpha = (i) => (target.has(i) ? 1 - merge * fade * 0.92 : 1);
    field.nodeScale = (i) => (groups.some((g) => g.keep === i) ? 1 + 0.9 * merge * fade : 1);
    legend.forEach((item, index) =>
      item.setAttribute("data-on", String(p > [0.55, 0.62, 0.7][index]! && fade > 0.5))
    );
  };

  field.decorate = (ctx) => {
    const glow = ease((phase - 0.55) / 0.1) * (1 - ease((phase - 0.92) / 0.08));
    if (glow <= 0) return;
    for (const group of groups) {
      const [x, y] = field.point(group.keep);
      ctx.globalAlpha = 0.22 * glow;
      ctx.fillStyle = field.palette.bright;
      ctx.beginPath();
      ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.fill();
    }
    const flag = ease((phase - 0.62) / 0.08) * (1 - ease((phase - 0.92) / 0.08));
    ctx.strokeStyle = field.palette.warning;
    ctx.lineWidth = 1.5;
    for (const i of flagged) {
      const [x, y] = field.point(i);
      ctx.globalAlpha = flag * (0.6 + 0.4 * Math.sin(performance.now() / 260));
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  };

  if (field.still) {
    apply(0.8);
    field.draw();
    return;
  }
  let start = performance.now();
  field.onTick = (now) => {
    if (now - start > cycle) start = now;
    apply((now - start) / cycle);
  };
  document.addEventListener("visibilitychange", () => !document.hidden && field.start());
  field.start();
}

const scenes: Record<string, (root: HTMLElement) => void> = { hero, capture, dream };

export function mount(root: HTMLElement): void {
  const scene = scenes[root.dataset.field ?? ""];
  if (!scene) return;
  root.setAttribute("data-live", "true");
  scene(root);
}
