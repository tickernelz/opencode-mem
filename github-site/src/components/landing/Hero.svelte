<script lang="ts">
  import type { Copy } from "../../i18n/en";
  import { heroGraph } from "../../lib/constellation";
  import numbers from "../../data/numbers.json";
  import GraphSvg from "./GraphSvg.svelte";

  type Props = { copy: Copy };
  let { copy }: Props = $props();

  const labels = [
    "never use browser confirm()",
    "shared types: packages/shared",
    "uses pnpm, not npm",
    "tests run with bun test",
    "prefers small PRs",
    "queue stays on SQLite",
    "retry fix broke the build",
    "CI pinned to Node 24",
    "dark theme is the default",
  ];
  const graph = heroGraph(labels);
  const stars = new Intl.NumberFormat("en").format(numbers.stars);
</script>

<section class="hero" data-pointer-area>
  <div class="hero__inner wrap">
    <div class="hero__copy">
      <h1 class="hero__title">{copy.hero.title}</h1>
      <p class="hero__lede">{copy.hero.lede}</p>
      <div class="hero__actions">
        <a class="button button--primary" href="#install">{copy.hero.primary}</a>
        <a class="button button--ghost" href="https://github.com/tickernelz/opencode-mem">
          <span>{copy.hero.secondary}</span>
          <span class="button__count">{stars}</span>
        </a>
      </div>
      <p class="hero__small">{copy.hero.small}</p>
    </div>
    <figure class="hero__visual" aria-label={copy.hero.figureLabel}>
      <div class="field field--hero" data-field="hero" data-labels={JSON.stringify(labels)}>
        <GraphSvg {graph} focus={labels[0]} />
        <canvas aria-hidden="true"></canvas>
      </div>
      <div class="chat" data-recall data-state="static">
        <p class="chat__line chat__line--you">
          <span class="chat__who">{copy.hero.you}</span>{copy.hero.ask}
        </p>
        <p class="chat__line chat__line--agent">
          <span class="chat__who" data-recall-anchor>{copy.hero.agent}</span><span
            class="chat__answer">{copy.hero.answer}</span
          >
        </p>
        <p class="chat__memory">
          <span class="chat__chip">{copy.hero.recalled}</span>
          <span class="chat__mem">{copy.hero.memory}</span>
        </p>
      </div>
      <figcaption class="hero__caption">{copy.hero.caption}</figcaption>
    </figure>
  </div>
</section>
