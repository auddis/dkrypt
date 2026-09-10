<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { cn } from '#lib/utils';

  interface Props extends HTMLInputAttributes {
    class?: string;
    ref?: HTMLInputElement;
  }

  let { class: className, value = $bindable(), ref = $bindable(), ...rest }: Props = $props();
</script>

<input
  bind:this={ref}
  bind:value
  data-slot="input"
  class={cn(
    'border-input bg-background ring-offset-background placeholder:text-muted-foreground flex h-9 w-full rounded-md border px-3 py-1 text-sm text-foreground shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
    className,
  )}
  {...rest}
/>
