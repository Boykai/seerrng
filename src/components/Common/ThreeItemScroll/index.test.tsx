import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import ThreeItemScroll, { visibleItemsHeight } from './index';

beforeEach(() => vi.stubGlobal('React', React));
it('caps measurement at three cards and two gaps', () => {
  expect(visibleItemsHeight([120, 150, 130, 900], 8)).toBe(416);
  expect(visibleItemsHeight([120], 8)).toBe(120);
  expect(visibleItemsHeight([], 8)).toBe(0);
});
it('retains all entries in an accessible scroll region', () => {
  const html = renderToStaticMarkup(
    <ThreeItemScroll label="Bibliography">
      {[1, 2, 3, 4].map((id) => (
        <article key={id}>Book {id}</article>
      ))}
    </ThreeItemScroll>
  );
  expect((html.match(/<article/g) ?? []).length).toBe(4);
  expect(html).toContain('aria-label="Bibliography"');
  expect(html).toContain('tabindex="0"');
});
