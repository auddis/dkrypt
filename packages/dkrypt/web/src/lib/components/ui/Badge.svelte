<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '#lib/utils';
  import { badgeVariantClasses, type BadgeVariant } from '#lib/components/ui/variants';

  interface Props extends HTMLAttributes<HTMLSpanElement> {
    variant?: BadgeVariant;
    children?: Snippet;
  }

  let { variant = 'default', class: className, children, ...rest }: Props = $props();
</script>

<span
  data-slot="badge"
  class={cn('inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap transition-colors', badgeVariantClasses[variant], className)}
  {...rest}
>
  {@render children?.()}
</span>
