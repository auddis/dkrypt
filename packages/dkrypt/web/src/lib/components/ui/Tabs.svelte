<script lang="ts">
  import { Tabs as TabsPrimitive } from 'bits-ui';
  import { scrollFade } from '#lib/scrollFade';
  import { cn } from '#lib/utils';

  interface TabItem {
    id: string;
    label: string;
  }

  interface Props {
    items: TabItem[];
    value: string;
    onValueChange: (value: string) => void;
    class?: string;
  }

  let { items, value, onValueChange, class: className }: Props = $props();
</script>

<TabsPrimitive.Root data-slot="tabs" {value} {onValueChange} class={cn('w-full', className)}>
  <div class="scroll-fade-x overflow-x-auto" use:scrollFade style="--scroll-fade-bg: var(--color-panel);">
	<TabsPrimitive.List data-slot="tabs-list" class="bg-ui-muted text-muted-foreground inline-flex min-w-full gap-1 rounded-lg p-1 sm:min-w-0">
      {#each items as item (item.id)}
        <TabsPrimitive.Trigger
          value={item.id}
			class="data-[state=active]:bg-background data-[state=active]:text-foreground focus-visible:ring-ring inline-flex cursor-pointer items-center justify-center rounded-md px-3 py-2 text-xs font-medium whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:outline-none data-[state=active]:shadow-sm"
        >
          {item.label}
        </TabsPrimitive.Trigger>
      {/each}
    </TabsPrimitive.List>
  </div>
</TabsPrimitive.Root>
