<script lang="ts">
  import type { Copy } from "../../i18n/en";

  type Props = { copy: Copy };
  let { copy }: Props = $props();
</script>

<section class="privacy" aria-labelledby="privacy-title">
  <div class="wrap privacy__grid">
    <h2 id="privacy-title">{copy.privacy.title}</h2>
    <ul class="privacy__list">
      {#each copy.privacy.points as [lead, text]}
        <li>
          <strong>{lead}</strong>
          {text}
        </li>
      {/each}
    </ul>
    <p class="privacy__note">{copy.privacy.note}</p>
  </div>
</section>
