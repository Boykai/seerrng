import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import BulkRequestItemCard from './BulkRequestItemCard';

vi.mock('swr', () => ({ default: () => ({ data: undefined }) }));
vi.mock('@app/components/Common/CachedImage', () => ({
  default: () => <span role="img" aria-label="Poster" />,
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => (
    <a {...props}>{children}</a>
  ),
}));
beforeEach(() => vi.stubGlobal('React', React));
const render = (
  props: Partial<React.ComponentProps<typeof BulkRequestItemCard>> = {}
) =>
  renderToStaticMarkup(
    <IntlProvider locale="en">
      <BulkRequestItemCard
        item={{
          id: 'OL27513W',
          title: 'Example Book',
          year: 1954,
          artist: 'An Author',
          isbn13: '1234567890123',
        }}
        mediaType="book"
        format="ebook"
        selected={false}
        onToggle={() => undefined}
        onNavigate={() => undefined}
        {...props}
      />
    </IntlProvider>
  );
it('uses the collection summary layout with selection and linked poster/title', () => {
  const html = render();
  for (const text of [
    'detail-item-surface',
    'detail-paired-columns',
    'Example Book (1954)',
    'An Author',
    '1234567890123',
    'Genres:',
    'selection-circle',
  ])
    expect(html).toContain(text);
  expect((html.match(/href="\/book\/OL27513W"/g) ?? []).length).toBe(2);
  expect(html).toContain('aria-label="Select Example Book"');
});
it('preserves request ineligibility and does not link unmatched music', () => {
  const html = render({
    item: {
      id: 'unmatched',
      title: 'Unmatched song',
      matchStatus: 'unmatched',
    },
    mediaType: 'music',
    reason: 'No confident match',
  });
  expect(html).toContain('disabled=""');
  expect(html).toContain('No confident match');
  expect(html).not.toContain('href=');
  expect(html).toContain('Artist:');
});
