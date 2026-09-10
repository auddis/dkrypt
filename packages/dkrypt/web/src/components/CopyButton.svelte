<script lang="ts">
  import { Check, Copy } from 'lucide-svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { showToast } from '#lib/ui.svelte';
  import { cn } from '#lib/utils';

  let { text, label, title }: { text: string; label?: string; title?: string } = $props();
  let copied = $state(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 1200);
    } catch {
      showToast("Couldn't copy - your browser blocked clipboard access", 'error', { track: false });
    }
  }
</script>

<Button
  variant="outline"
  size={label ? 'sm' : 'icon'}
  onclick={copy}
  class={cn(
    'shrink-0 text-muted hover:text-foreground',
    label ? 'h-7 px-2.5 text-xs' : 'h-6 w-6',
  )}
  aria-label={title ?? label ?? 'Copy'}
  title={title ?? label ?? 'Copy'}
>
  {#if copied}
    <Check class="text-ok h-3.5 w-3.5" />
  {:else}
    <Copy class="h-3.5 w-3.5" />
  {/if}
  {#if label}{copied ? 'Copied!' : label}{/if}
</Button>
