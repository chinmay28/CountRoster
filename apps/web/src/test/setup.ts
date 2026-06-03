import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// With Vitest globals off, Testing Library can't auto-register its cleanup via
// a global `afterEach`, so renders would accumulate across tests. Do it here.
afterEach(cleanup);

// jsdom has no SVG layout engine; Observable Plot / d3 measure text via these
// to compute margins. Stub them so charts render in component tests.
type SvgWithLayout = {
  getBBox?: () => { x: number; y: number; width: number; height: number };
  getComputedTextLength?: () => number;
};
if (typeof SVGElement !== 'undefined') {
  const proto = SVGElement.prototype as unknown as SvgWithLayout;
  proto.getBBox ??= () => ({ x: 0, y: 0, width: 0, height: 0 });
  proto.getComputedTextLength ??= () => 0;
}
