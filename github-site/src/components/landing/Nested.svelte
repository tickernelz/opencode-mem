<script lang="ts">
  import type { Copy } from "../../i18n/en";

  type Props = { copy: Copy };
  let { copy }: Props = $props();

  const rows = [70, 180, 290];
</script>

<section class="nested" aria-labelledby="nested-title">
  <div class="wrap nested__grid">
    <div class="nested__text">
      <h2 id="nested-title">{copy.nested.title}</h2>
      <p>{copy.nested.body}</p>
    </div>
    <svg class="nested__map" viewBox="0 0 560 360" role="img" aria-label={copy.nested.label}>
      <text class="nested__root" x="8" y="22">{copy.nested.root}</text>
      <text class="nested__marker" x="8" y="44">.opencode-mem-project</text>
      {#each rows as y, i}
        <g>
          <text class="nested__repo" x="24" y={y + 34}>{copy.nested.repos[i]}</text>
          <path
            class="nested__branch"
            style={`--i:${i}`}
            d={`M 24 ${y + 46} H 190 C 300 ${y + 46}, 330 180, 430 180`}
          />
        </g>
      {/each}
      <circle class="nested__halo" cx="444" cy="180" r="34" />
      <circle class="nested__node" cx="444" cy="180" r="12" />
      <text class="nested__shared" x="444" y="244" text-anchor="middle">{copy.nested.shared}</text>
    </svg>
  </div>
</section>
