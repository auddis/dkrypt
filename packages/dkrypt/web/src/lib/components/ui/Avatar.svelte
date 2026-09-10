<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '#lib/utils';

  interface Props extends HTMLAttributes<HTMLDivElement> {
    src?: string;
    alt?: string;
    fallback?: string;
    class?: string;
  }

  let { src, alt = '', fallback = '?', class: className, ...rest }: Props = $props();
</script>

<div data-slot="avatar" class={cn('bg-ui-muted text-muted-foreground relative flex size-9 shrink-0 overflow-hidden rounded-full', className)} {...rest}>
  {#if src}
    <img data-slot="avatar-image" src={src} {alt} class="aspect-square size-full object-cover" />
  {:else}
    <span data-slot="avatar-fallback" class="flex size-full items-center justify-center text-xs font-medium">{fallback}</span>
  {/if}
</div>
