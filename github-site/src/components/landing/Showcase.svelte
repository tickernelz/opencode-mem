<script lang="ts">
  import type { Copy } from "../../i18n/en";
  import memoriesDark from "../../assets/ui/ui-project-dark.png";
  import memoriesLight from "../../assets/ui/ui-project-light.png";
  import profileDark from "../../assets/ui/ui-profile-dark.png";
  import profileLight from "../../assets/ui/ui-profile-light.png";
  import skillsDark from "../../assets/ui/ui-skills-dark.png";
  import skillsLight from "../../assets/ui/ui-skills-light.png";
  import statsDark from "../../assets/ui/ui-stats-dark.png";
  import statsLight from "../../assets/ui/ui-stats-light.png";

  type Props = { copy: Copy };
  let { copy }: Props = $props();

  function src(image: string | { src: string }): string {
    return typeof image === "string" ? image : image.src;
  }

  const shots: Record<string, { dark: string; light: string }> = {
    memories: { dark: src(memoriesDark), light: src(memoriesLight) },
    profile: { dark: src(profileDark), light: src(profileLight) },
    skills: { dark: src(skillsDark), light: src(skillsLight) },
    stats: { dark: src(statsDark), light: src(statsLight) },
  };
</script>

<section class="showcase" aria-labelledby="showcase-title">
  <div class="wrap">
    <header class="section-head">
      <h2 id="showcase-title">{copy.showcase.title}</h2>
      <p>{copy.showcase.lede}</p>
    </header>
    <div class="tabs" role="tablist" aria-label={copy.showcase.title} data-tabs="showcase">
      {#each copy.showcase.tabs as [id, label], i}
        <button
          type="button"
          role="tab"
          id={`shot-tab-${id}`}
          aria-controls={`shot-${id}`}
          aria-selected={i === 0 ? "true" : "false"}
          tabindex={i === 0 ? undefined : -1}
        >
          {label}
        </button>
      {/each}
    </div>
    <figure class="showcase__frame">
      {#each copy.showcase.tabs as [id, label], i}
        <div role="tabpanel" id={`shot-${id}`} aria-labelledby={`shot-tab-${id}`} hidden={i !== 0}>
          <img
            class="shot shot--dark"
            src={shots[id]!.dark}
            alt={`opencode-mem web UI, ${label} view, dark theme`}
            loading="lazy"
            decoding="async"
          />
          <img
            class="shot shot--light"
            src={shots[id]!.light}
            alt={`opencode-mem web UI, ${label} view, light theme`}
            loading="lazy"
            decoding="async"
          />
        </div>
      {/each}
    </figure>
  </div>
</section>
