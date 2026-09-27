import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import CardTextVisibilityToggle from './index';

vi.mock('@app/hooks/useCardTextVisibility', () => ({
  default: () => ({
    visibility: { album: 'always' },
    setVisibility: vi.fn(),
  }),
}));
vi.mock('@app/components/Common/Tooltip', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
beforeEach(() => vi.stubGlobal('React', React));

it('shows Title View with a text-oriented icon and keeps its pressed state', () => {
  const html = renderToStaticMarkup(
    <IntlProvider locale="en">
      <CardTextVisibilityToggle mediaType="album" />
    </IntlProvider>
  );
  expect(html).toContain('Title View');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('Only show titles on hover');
  expect(html).toContain('<svg');
});
