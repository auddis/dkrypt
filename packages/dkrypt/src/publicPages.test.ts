import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { renderPublicPage } from '#publicPages.js';
import { config } from '#config.js';

const shell = '<html><body><div id="app-root"></div></body></html>';
const browserShell = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

describe('renderPublicPage', () => {
  test.each([
    ['/', 'subscription service'],
    ['/pricing', '€5/month'],
    ['/terms', 'Stripe Managed Payments handles eligible card or bank purchases as merchant of record'],
    ['/privacy', 'Privacy notice'],
    ['/refund-policy', '14 days'],
    ['/contact', 'Contact dkrypt'],
    ['/status', 'dkrypt service status'],
  ])('renders public fallback content for %s', (pathname, expected) => {
    const rendered = renderPublicPage(shell, pathname);

    expect(rendered).toContain('data-app-fallback');
    expect(rendered).toContain(expected);
    expect(rendered).toContain('contact<span>@</span>dylib.dev');
    expect(rendered).not.toContain('<div id="app-root"></div>');
  });

  test('hides the fallback before the app module loads in JavaScript browsers', () => {
    const rendered = renderPublicPage(browserShell, '/');
    const activationIndex = rendered.indexOf("document.documentElement.classList.add('js')");
    const fallbackIndex = rendered.indexOf('<div data-app-fallback');

    expect(activationIndex).toBeGreaterThan(-1);
    expect(rendered).toContain('html.js [data-app-fallback]');
    expect(activationIndex).toBeLessThan(fallbackIndex);
    expect(rendered).not.toContain('<div data-app-fallback hidden');
  });

  test('renders distinct monthly prices for every paid tier', () => {
    const previous = config.billingCatalogRollout;
    config.billingCatalogRollout = 'all';
    try {
      const rendered = renderPublicPage(shell, '/pricing');
      for (const label of ['Access — €2.50/month', 'Standard — €5/month', 'Plus — €10/month', 'Developer — €15/month', 'Unlimited — €20/month', 'Unlimited Priority — €30/month']) expect(rendered).toContain(label);
      expect(rendered).not.toContain('Regular — €5/month');
      expect(rendered).toContain('IPA Library access');
    } finally {
      config.billingCatalogRollout = previous;
    }
  });
});
