<script lang="ts">
  type Props = {
    file: string;
    code: string;
    copyLabel: string;
    copiedLabel: string;
  };

  let { file, code, copyLabel, copiedLabel }: Props = $props();
</script>

<div class="code">
  <div class="code__bar">
    <span class="code__file">{file}</span>
    <button class="code__copy" type="button" data-copy={code} data-copied={copiedLabel}>
      <span data-copy-label>{copyLabel}</span>
    </button>
  </div>
  <pre><code>{code}</code></pre>
</div>
