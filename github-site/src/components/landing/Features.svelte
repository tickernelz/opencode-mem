<script lang="ts">
  import type { Copy } from "../../i18n/en";

  type Props = { copy: Copy };
  let { copy }: Props = $props();
</script>

<section class="features" id="features" aria-labelledby="features-title">
  <div class="wrap features__grid">
    <header class="features__head">
      <h2 id="features-title">{copy.features.title}</h2>
      <p>{copy.features.lede}</p>
    </header>
    <dl class="features__list">
      {#each copy.features.items as [name, line]}
        <div class="feature">
          <dt>{name}</dt>
          <dd>{line}</dd>
        </div>
      {/each}
    </dl>
  </div>
  <div class="wrap hood">
    <h3>{copy.hood.title}</h3>
    <ul>
      {#each copy.hood.items as item}
        <li>{item}</li>
      {/each}
    </ul>
    <a class="link-arrow" href="/docs/configure/embeddings/">{copy.hood.link}</a>
  </div>
</section>
