import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard for spec 0064 (GitHub issue #91). Capacitor's SystemBars plugin only
// stops padding the WebView parent by the display-cutout inset when the page's
// last `meta[name=viewport]` content contains the exact substring
// `viewport-fit=cover`. If that token is dropped, the cutout-height gray strip
// above the header returns — the bug four prior specs chased. This test fails
// loudly if a future edit removes or mangles the token.
//
// The vite config `root` is `apps/mobile`, so `__dirname` resolves the sibling
// `index.html`.
const indexHtml = readFileSync(join(__dirname, 'index.html'), 'utf8');

describe('index.html viewport meta', () => {
  it('contains the exact viewport-fit=cover token (raw, not whitespace-normalized)', () => {
    // F3: assert the raw file substring so a rewrapped/stray-space defect is not
    // masked by normalization.
    expect(indexHtml).toContain('viewport-fit=cover');
  });

  it('carries viewport-fit=cover in the last viewport meta content (the runtime condition)', () => {
    // Mirror what SystemBars actually checks: the DOM-parsed content of the last
    // meta[name=viewport]. This makes the guard meaningful — a bare substring
    // sitting in a comment would not satisfy the native check.
    const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
    const viewports = doc.querySelectorAll('meta[name=viewport]');
    expect(viewports.length).toBeGreaterThan(0);
    const lastContent =
      viewports[viewports.length - 1].getAttribute('content') ?? '';
    expect(lastContent).toContain('viewport-fit=cover');
  });
});
