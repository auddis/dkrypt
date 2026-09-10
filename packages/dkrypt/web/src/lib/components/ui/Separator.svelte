<script lang="ts">
  import { Separator as SeparatorPrimitive } from 'bits-ui';
  import { cn } from '#lib/utils';

  interface Props {
    orientation?: 'horizontal' | 'vertical';
    decorative?: boolean;
    class?: string;
  }

  let { orientation = 'horizontal', decorative = true, class: className }: Props = $props();
</script>

<SeparatorPrimitive.Root {orientation} {decorative} data-slot="separator" class={cn('bg-border shrink-0', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)} />
