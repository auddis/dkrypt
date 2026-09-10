<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '#lib/utils';

  type AlertVariant = 'default' | 'success' | 'warning' | 'destructive';

  interface Props extends HTMLAttributes<HTMLDivElement> {
    variant?: AlertVariant;
    class?: string;
    children?: import('svelte').Snippet;
  }

  const variantClasses: Record<AlertVariant, string> = {
    default: 'border-border bg-card text-card-foreground',
    success: 'border-ok/30 bg-ok/10 text-foreground',
    warning: 'border-warn/30 bg-warn/10 text-foreground',
    destructive: 'border-destructive/30 bg-destructive/10 text-foreground',
  };

  let { variant = 'default', class: className, children, ...rest }: Props = $props();
</script>

<div data-slot="alert" role="status" class={cn('relative w-full rounded-lg border px-4 py-3 text-sm [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4', variantClasses[variant], className)} {...rest}>
  {@render children?.()}
</div>
