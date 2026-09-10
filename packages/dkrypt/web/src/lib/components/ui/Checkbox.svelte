<script lang="ts">
  import { Checkbox as CheckboxPrimitive } from 'bits-ui';
  import { Check, Minus } from 'lucide-svelte';
  import { cn } from '#lib/utils';

  interface Props {
    checked: boolean;
    indeterminate?: boolean;
    disabled?: boolean;
    class?: string;
    'aria-label'?: string;
    onchange?: (event: Event) => void;
    onCheckedChange?: (checked: boolean) => void;
  }

  let { checked = $bindable(), indeterminate = $bindable(false), disabled = false, class: className, ...rest }: Props = $props();
</script>

<CheckboxPrimitive.Root
  bind:checked
  bind:indeterminate
  {disabled}
  data-slot="checkbox"
  class={cn('border-input data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background peer h-4 w-4 shrink-0 rounded-[4px] border shadow-sm outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50', className)}
  {...rest}
>
  {#if indeterminate}
    <Minus class="size-3.5" strokeWidth={2.5} />
  {:else if checked}
    <Check class="size-3.5" strokeWidth={2.5} />
  {/if}
</CheckboxPrimitive.Root>
