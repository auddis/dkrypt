<script lang="ts">
  import { buttonVariants } from '#lib/components/ui/variants';
  import LegalLinks from '#components/LegalLinks.svelte';
</script>

<header class="border-border border-b">
  <div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-5 py-4">
    <a href="/" class="text-base font-semibold text-text no-underline">dkrypt</a>
    <LegalLinks />
    <a href="/#sign-in" class={buttonVariants('default', 'sm')}>
      Sign in
    </a>
  </div>
</header>
