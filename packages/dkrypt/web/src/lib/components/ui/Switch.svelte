<script lang="ts">
  import { Switch as SwitchPrimitive } from 'bits-ui';
  import { cn } from '#lib/utils';

  interface Props {
    checked: boolean;
    disabled?: boolean;
    class?: string;
    'aria-label'?: string;
    onCheckedChange?: (checked: boolean) => void;
  }

  let { checked = $bindable(), disabled = false, class: className, ...rest }: Props = $props();
</script>

<SwitchPrimitive.Root
  bind:checked
  {disabled}
	data-slot="switch"
	class={cn(
		'border-input focus-visible:ring-ring data-[state=checked]:bg-primary data-[state=unchecked]:bg-input relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border shadow-inner transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
    className,
  )}
  {...rest}
>
  <SwitchPrimitive.Thumb
		class="bg-background pointer-events-none block h-3.5 w-3.5 translate-x-1 rounded-full shadow-sm transition-transform data-[state=checked]:translate-x-[18px]"
  />
</SwitchPrimitive.Root>
