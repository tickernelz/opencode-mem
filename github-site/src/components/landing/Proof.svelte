<script lang="ts">
  import type { Copy } from "../../i18n/en";
  import numbers from "../../data/numbers.json";

  type Props = { copy: Copy };
  let { copy }: Props = $props();

  const format = new Intl.NumberFormat("en");
  const items = $derived([
    [format.format(numbers.stars), copy.proof.stars],
    [format.format(numbers.forks), copy.proof.forks],
    [format.format(numbers.downloadsYear), copy.proof.downloads],
    [format.format(numbers.releases), `${copy.proof.releases} v${numbers.version}`],
  ] as const);
</script>

<section class="proof" aria-labelledby="proof-title">
  <div class="wrap">
    <h2 id="proof-title">{copy.proof.title}</h2>
    <ul class="proof__row">
      {#each items as [value, label]}
        <li>
          <span class="proof__value">{value}</span>
          <span class="proof__label">{label}</span>
        </li>
      {/each}
    </ul>
  </div>
</section>
