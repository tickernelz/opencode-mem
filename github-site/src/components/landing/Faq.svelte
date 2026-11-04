<script lang="ts">
  import type { Copy } from "../../i18n/en";

  type Props = { copy: Copy };
  let { copy }: Props = $props();
</script>

<section class="faq" id="faq" aria-labelledby="faq-title">
  <div class="wrap faq__grid">
    <h2 id="faq-title">{copy.faq.title}</h2>
    <div class="faq__list">
      {#each copy.faq.items as [question, answer]}
        <details>
          <summary>{question}</summary>
          <p>{answer}</p>
        </details>
      {/each}
    </div>
  </div>
</section>
