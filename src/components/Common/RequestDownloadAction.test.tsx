import { MediaType } from '@server/constants/media';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import RequestDownloadAction, {
  filterRequestDownloadAssets,
} from './RequestDownloadAction';

const mockState = vi.hoisted(() => ({
  keys: [] as (string | null)[],
  requestStatus: undefined as unknown,
  downloads: undefined as unknown,
}));

vi.mock('swr', () => ({
  default: (key: string | null) => {
    mockState.keys.push(key);
    if (!key) return {};
    return key.startsWith('/api/v1/request/status?')
      ? { data: mockState.requestStatus }
      : { data: mockState.downloads };
  },
}));

vi.mock('@app/hooks/useUser', () => ({
  useUser: () => ({ user: { id: 17 } }),
}));

vi.mock('@app/components/Common/Tooltip', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

const renderAction = (
  mediaType: MediaType.BOOK | MediaType.COMIC | MediaType.MAGAZINE,
  bookFormat?: 'ebook' | 'audiobook'
) =>
  renderToStaticMarkup(
    <IntlProvider locale="en">
      <RequestDownloadAction
        mediaId={505}
        mediaType={mediaType}
        bookFormat={bookFormat}
      />
    </IntlProvider>
  );

beforeEach(() => {
  mockState.keys = [];
  mockState.requestStatus = {
    results: [
      {
        request: { id: 42, bookFormat: 'both' },
        status: { stage: 'available' },
      },
    ],
  };
  mockState.downloads = {
    assets: [],
    hadErrors: false,
  };
});

it('lists comic issue files from the matching available request', () => {
  mockState.downloads = {
    assets: [
      { id: 'comic-one', name: 'series-01.cbz', requestId: 42 },
      { id: 'comic-two', name: 'series-02.cbz', requestId: 42 },
    ],
    hadErrors: false,
  };

  const html = renderAction(MediaType.COMIC);

  expect(mockState.keys[0]).toContain('mediaType=comic');
  expect(mockState.keys[0]).toContain('mediaId=505');
  expect(html).toContain('Choose comic issues');
  expect(html).toContain('series-01.cbz');
  expect(html).toContain('series-02.cbz');
  expect(html).toContain('/api/v1/request/status/42/downloads/comic-one');
});

it('lists a magazine issue as a downloadable copy', () => {
  mockState.downloads = {
    assets: [
      { id: 'magazine-one', name: 'monthly-2026-10.pdf', requestId: 42 },
    ],
    hadErrors: false,
  };

  const html = renderAction(MediaType.MAGAZINE);

  expect(mockState.keys[0]).toContain('mediaType=magazine');
  expect(mockState.keys[0]).toContain('mediaId=505');
  expect(html).toContain('Download issue');
  expect(html).toContain('Download monthly-2026-10.pdf');
  expect(html).toContain('/api/v1/request/status/42/downloads/magazine-one');
});

it('keeps working downloads visible when another provider lookup failed', () => {
  mockState.downloads = {
    assets: [{ id: 'comic-one', name: 'series-01.cbz', requestId: 42 }],
    hadErrors: true,
  };

  const html = renderAction(MediaType.COMIC);

  expect(html).toContain('series-01.cbz');
  expect(html).toContain('Some files could not be checked');
  expect(html).toContain('Request Status');
});

it('keeps audiobook downloads separate from ebook files in a combined request', () => {
  mockState.downloads = {
    assets: [
      {
        id: 'audio-one',
        name: 'book.m4b',
        format: 'audiobook',
        requestId: 42,
      },
    ],
    hadErrors: false,
  };

  const html = renderAction(MediaType.BOOK, 'audiobook');

  expect(mockState.keys[0]).toContain('bookFormat=audiobook');
  expect(html).toContain('Download audiobook');
  expect(html).toContain('Download book.m4b');
  expect(html).not.toContain('book.epub');
  expect(html).toContain('/api/v1/request/status/42/downloads/audio-one');
});

it('filters mixed book files by requested format', () => {
  const assets = filterRequestDownloadAssets(
    [
      { id: 'ebook-one', name: 'book.epub', format: 'ebook' },
      { id: 'audio-one', name: 'book.m4b', format: 'audiobook' },
    ],
    MediaType.BOOK,
    'audiobook'
  );

  expect(assets.map(({ name }) => name)).toEqual(['book.m4b']);
});
