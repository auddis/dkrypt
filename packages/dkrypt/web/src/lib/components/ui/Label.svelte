<script lang="ts">
  import type { HTMLLabelAttributes } from 'svelte/elements';
  import { cn } from '#lib/utils';

  interface Props extends HTMLLabelAttributes {
    class?: string;
    children?: import('svelte').Snippet;
  }

  let { class: className, children, ...rest }: Props = $props();
</script>

<label data-slot="label" class={cn('text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70', className)} {...rest}>
  {@render children?.()}
</label>
