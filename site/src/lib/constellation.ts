export interface MemoryNode {
  x: number;
  y: number;
  r: number;
  z: number;
  cluster: number;
  label?: string;
}

export interface MemoryGraph {
  width: number;
  height: number;
  nodes: MemoryNode[];
  edges: Array<[number, number]>;
}

export interface ClusterSpec {
  x: number;
  y: number;
  spread: number;
  count: number;
}

export interface GraphSpec {
  seed: number;
  width: number;
  height: number;
  clusters: ClusterSpec[];
  labels?: string[];
  links?: number;
}

export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distance(a: MemoryNode, b: MemoryNode): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function buildGraph(spec: GraphSpec): MemoryGraph {
  const random = seeded(spec.seed);
  const nodes: MemoryNode[] = [];
  spec.clusters.forEach((cluster, index) => {
    for (let i = 0; i < cluster.count; i++) {
      const angle = random() * Math.PI * 2;
      const reach = Math.sqrt(random()) * cluster.spread;
      nodes.push({
        x: cluster.x + Math.cos(angle) * reach,
        y: cluster.y + Math.sin(angle) * reach * 0.8,
        r: i === 0 ? 5 : 1.6 + random() * 2.6,
        z: 0.35 + random() * 0.65,
        cluster: index,
      });
    }
  });

  const edges: Array<[number, number]> = [];
  const seen = new Set<string>();
  const add = (a: number, b: number) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (a === b || seen.has(key)) return;
    seen.add(key);
    edges.push([a, b]);
  };
  const links = spec.links ?? 2;
  nodes.forEach((node, i) => {
    nodes
      .map((other, j) => ({
        j,
        d: other.cluster === node.cluster ? distance(node, other) : Infinity,
      }))
      .filter(({ j, d }) => j !== i && Number.isFinite(d))
      .sort((a, b) => a.d - b.d)
      .slice(0, links)
      .forEach(({ j }) => add(i, j));
  });
  for (let c = 1; c < spec.clusters.length; c++) {
    let best: [number, number] = [0, 0];
    let bestDistance = Infinity;
    nodes.forEach((a, i) => {
      if (a.cluster !== c) return;
      nodes.forEach((b, j) => {
        if (b.cluster >= c) return;
        const d = distance(a, b);
        if (d < bestDistance) {
          bestDistance = d;
          best = [i, j];
        }
      });
    });
    add(best[0], best[1]);
  }

  const anchors = spec.clusters.map((_, index) =>
    nodes.findIndex((node) => node.cluster === index)
  );
  (spec.labels ?? []).forEach((label, i) => {
    const anchor = anchors[i % anchors.length] ?? 0;
    const pool = nodes
      .map((node, j) => ({ node, j }))
      .filter(({ node }) => node.cluster === nodes[anchor]?.cluster && !node.label);
    const pick = i < anchors.length ? anchor : pool[Math.floor(random() * pool.length)]?.j;
    if (pick !== undefined && nodes[pick]) nodes[pick].label = label;
  });

  return { width: spec.width, height: spec.height, nodes, edges };
}

export function heroGraph(labels: string[]): MemoryGraph {
  return buildGraph({
    seed: 1818,
    width: 1000,
    height: 820,
    clusters: [
      { x: 520, y: 330, spread: 160, count: 18 },
      { x: 790, y: 220, spread: 130, count: 14 },
      { x: 300, y: 570, spread: 140, count: 14 },
      { x: 770, y: 580, spread: 150, count: 15 },
      { x: 190, y: 240, spread: 120, count: 11 },
    ],
    labels,
  });
}

export function captureGraph(): MemoryGraph {
  return buildGraph({
    seed: 4747,
    width: 640,
    height: 280,
    clusters: [
      { x: 150, y: 130, spread: 95, count: 10 },
      { x: 340, y: 160, spread: 100, count: 10 },
      { x: 520, y: 120, spread: 90, count: 8 },
    ],
  });
}

export function dreamGraph(): MemoryGraph {
  return buildGraph({
    seed: 2026,
    width: 1200,
    height: 640,
    links: 3,
    clusters: [
      { x: 220, y: 260, spread: 120, count: 9 },
      { x: 480, y: 420, spread: 120, count: 9 },
      { x: 720, y: 220, spread: 120, count: 9 },
      { x: 980, y: 400, spread: 130, count: 9 },
    ],
  });
}
