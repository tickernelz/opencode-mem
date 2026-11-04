<script lang="ts">
  import type { Copy } from "../../i18n/en";
  import { dreamGraph } from "../../lib/constellation";
  import GraphSvg from "./GraphSvg.svelte";

  type Props = { copy: Copy };
  let { copy }: Props = $props();

  const graph = dreamGraph();
</script>

<section class="dream" aria-labelledby="dream-title">
  <div class="dream__sky">
    <figure class="field field--dream" data-field="dream" aria-label={copy.dream.label}>
      <GraphSvg {graph} />
      <canvas aria-hidden="true"></canvas>
      <figcaption class="dream__legend">
        {#each copy.dream.legend as item, i}
          <span class={["dream__key", `dream__key--${i}`].join(" ")} data-legend data-on="true">
            {item}
          </span>
        {/each}
      </figcaption>
    </figure>
    <div class="wrap dream__copy">
      <h2 id="dream-title">{copy.dream.title}</h2>
      <p>{copy.dream.body}</p>
      <code class="dream__code">"dreaming": {"{"} "enabled": true {"}"}</code>
    </div>
  </div>
</section>
