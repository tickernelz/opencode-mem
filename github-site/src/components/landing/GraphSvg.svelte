<script lang="ts">
  import type { MemoryGraph } from "../../lib/constellation";

  type Props = {
    graph: MemoryGraph;
    focus?: string;
    class?: string;
    fit?: "slice" | "meet";
  };

  let { graph, focus, class: className = "", fit = "slice" }: Props = $props();

  const focusIndex = $derived(focus ? graph.nodes.findIndex((node) => node.label === focus) : -1);
</script>

<svg
  class={["graph-svg", className].filter(Boolean).join(" ")}
  viewBox={`0 0 ${graph.width} ${graph.height}`}
  preserveAspectRatio={`xMidYMid ${fit}`}
  aria-hidden="true"
  focusable="false"
>
  <g class="graph-svg__edges">
    {#each graph.edges as [a, b]}
      <line
        x1={graph.nodes[a]!.x}
        y1={graph.nodes[a]!.y}
        x2={graph.nodes[b]!.x}
        y2={graph.nodes[b]!.y}
      />
    {/each}
  </g>
  <g class="graph-svg__nodes">
    {#each graph.nodes as node, i}
      <circle
        cx={node.x}
        cy={node.y}
        r={(node.r * (0.7 + node.z * 0.5)).toFixed(2)}
        class:is-focus={i === focusIndex}
        style={`opacity:${(0.4 + node.z * 0.45).toFixed(2)}`}
      />
    {/each}
  </g>
</svg>
