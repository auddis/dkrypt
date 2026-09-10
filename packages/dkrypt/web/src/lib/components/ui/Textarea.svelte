<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements';
  import { cn } from '#lib/utils';

  interface Props extends HTMLTextareaAttributes {
    class?: string;
    value?: string;
    ref?: HTMLTextAreaElement;
  }

  let { class: className, value = $bindable(), ref = $bindable(), ...rest }: Props = $props();
</script>

<textarea bind:this={ref} bind:value data-slot="textarea" class={cn('border-input bg-background ring-offset-background placeholder:text-muted-foreground flex min-h-20 w-full rounded-md border px-3 py-2 text-sm text-foreground shadow-sm focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50', className)} {...rest}></textarea>
