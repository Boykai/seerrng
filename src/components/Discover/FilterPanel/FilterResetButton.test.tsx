import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { FilterResetButton } from './CompactFilterSelect';

beforeEach(() => vi.stubGlobal('React', React));

it('renders the shared reset icon and selected state', () => {
  const html = renderToStaticMarkup(
    <FilterResetButton label="Clear Filters" selected onClick={() => {}} />
  );
  expect(html).toContain('Clear Filters');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('app-filter-button-active');
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('<svg');
});

it('looks available when there are filters to clear', () => {
  const html = renderToStaticMarkup(
    <FilterResetButton
      label="Clear Filters"
      selected={false}
      onClick={() => {}}
    />
  );
  expect(html).toContain('app-filter-button-idle');
  expect(html).not.toContain('app-filter-reset-button-idle');
  expect(html).not.toContain('disabled=');
});
