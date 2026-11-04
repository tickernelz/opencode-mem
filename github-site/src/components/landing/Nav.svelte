<script lang="ts">
  import { onMount } from "svelte";
  import Moon from "@lucide/svelte/icons/moon";
  import Sun from "@lucide/svelte/icons/sun";
  import type { Copy } from "../../i18n/en";
  import BrandMark from "../BrandMark.svelte";
  import GithubIcon from "../GithubIcon.svelte";

  type Props = { copy: Copy };
  let { copy }: Props = $props();

  let isDark = $state(true);

  onMount(() => {
    isDark = document.documentElement.dataset.theme !== "light";
  });

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("om-theme", next);
    isDark = next !== "light";
  }
</script>

<a class="skip" href="#main">{copy.nav.skip}</a>
<header class="nav">
  <div class="nav__inner wrap">
    <BrandMark />
    <nav class="nav__links" aria-label="Main">
      <a class="nav__optional" href="#how">{copy.nav.how}</a>
      <a class="nav__optional" href="#features">{copy.nav.features}</a>
      <a class="nav__optional" href="#faq">{copy.nav.faq}</a>
      <a href="/docs/">{copy.nav.docs}</a>
      <a
        class="theme-toggle"
        href="https://github.com/tickernelz/opencode-mem"
        aria-label={copy.nav.github}
        title={copy.nav.github}
      >
        <GithubIcon />
      </a>
      <button
        class="theme-toggle"
        type="button"
        aria-label={copy.nav.theme}
        title={copy.nav.theme}
        onclick={toggleTheme}
      >
        {#if isDark}
          <Moon aria-hidden="true" />
        {:else}
          <Sun aria-hidden="true" />
        {/if}
      </button>
    </nav>
  </div>
</header>
