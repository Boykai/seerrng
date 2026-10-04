import { MediaType } from '@server/constants/media';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { SWRConfig, type Cache } from 'swr';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RequestDownloadAction, canDownloadRequestCopy } from '.';

const fetcher = vi.fn();
let cache: Cache;
let root: Root;
let host: HTMLDivElement;
let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  cache = new Map();
  fetcher.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const chapter = (number: number) => ({
  id: `chapter-${number}`,
  name: `Sample Manga - Ch. ${number}.cbz`,
});

const render = (props: { enabled: boolean; revision: string }) =>
  act(async () =>
    root.render(
      <IntlProvider locale="en">
        <SWRConfig
          value={{ provider: () => cache, fetcher, dedupingInterval: 0 }}
        >
          <RequestDownloadAction requestId={7} {...props} />
        </SWRConfig>
      </IntlProvider>
    )
  );

const links = () =>
  [...host.querySelectorAll('a')].map((link) => ({
    href: link.getAttribute('href'),
    label: link.getAttribute('aria-label'),
  }));

const listToggle = () =>
  host.querySelector<HTMLButtonElement>('button[aria-expanded]');

const stages = [
  'requested',
  'approved',
  'searching',
  'downloading',
  'importing',
  'library',
  'available',
  'unavailable',
  'failed',
  'declined',
  'cancelled',
] as const;

it('offers manga chapters while downloading, after a failure or once available, and other media once available', () => {
  expect(
    stages.filter((stage) => canDownloadRequestCopy(MediaType.MANGA, stage))
  ).toEqual(['downloading', 'available', 'failed']);
  for (const type of Object.values(MediaType).filter(
    (value) => value !== MediaType.MANGA
  )) {
    expect(
      stages.filter((stage) => canDownloadRequestCopy(type, stage))
    ).toEqual(['available']);
  }
});

it('shows a downloading manga request its verified chapters and picks up a newly verified one without a reload', async () => {
  fetcher.mockResolvedValueOnce({ results: [chapter(1)] });
  await render({
    enabled: canDownloadRequestCopy(MediaType.MANGA, 'downloading'),
    revision: 'downloading:10',
  });

  expect(fetcher.mock.calls).toEqual([['/api/v1/request/status/7/downloads']]);
  expect(links()).toEqual([
    {
      href: '/api/v1/request/status/7/downloads/chapter-1',
      label: 'Download Sample Manga - Ch. 1.cbz',
    },
  ]);

  // The status poll reports no progress: nothing is asked again.
  await render({ enabled: true, revision: 'downloading:10' });
  expect(fetcher).toHaveBeenCalledTimes(1);

  fetcher.mockResolvedValueOnce({ results: [chapter(2), chapter(1)] });
  await render({ enabled: true, revision: 'downloading:20' });

  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(listToggle()?.textContent).toBe('Download copies');
  expect(listToggle()?.getAttribute('aria-expanded')).toBe('false');
  expect(links()).toEqual([]);

  await act(async () => listToggle()?.click());

  // The list opens inside the card, on its own line, never as a floating menu.
  expect(listToggle()?.getAttribute('aria-expanded')).toBe('true');
  const list = host.querySelector(
    `#${listToggle()?.getAttribute('aria-controls')}`
  );
  expect(list?.className).toBe(
    'request-download-copy-panel app-card-inset refreshed-inset-surface'
  );
  expect(list?.getAttribute('aria-labelledby')).toBe(
    list?.querySelector('h4')?.id
  );
  expect(list?.querySelector('h4')?.textContent).toBe('Download Copies');
  expect(host.querySelector('details')).toBeNull();
  expect(links().map(({ label }) => label)).toEqual([
    'Download Sample Manga - Ch. 2.cbz',
    'Download Sample Manga - Ch. 1.cbz',
  ]);

  // An open list stays open and gains the next verified chapter.
  fetcher.mockResolvedValueOnce({
    results: [chapter(3), chapter(2), chapter(1)],
  });
  await render({ enabled: true, revision: 'downloading:30' });

  expect(listToggle()?.getAttribute('aria-expanded')).toBe('true');
  expect(links().map(({ href }) => href)).toEqual([
    '/api/v1/request/status/7/downloads/chapter-3',
    '/api/v1/request/status/7/downloads/chapter-2',
    '/api/v1/request/status/7/downloads/chapter-1',
  ]);

  await act(async () => listToggle()?.click());

  expect(listToggle()?.getAttribute('aria-expanded')).toBe('false');
  expect(listToggle()?.hasAttribute('aria-controls')).toBe(false);
  expect(links()).toEqual([]);
});

it('asks for nothing before the request offers copies, then loads them once', async () => {
  await render({
    enabled: canDownloadRequestCopy(MediaType.MANGA, 'approved'),
    revision: 'approved:',
  });

  expect(fetcher).not.toHaveBeenCalled();
  expect(host.innerHTML).toBe('');

  fetcher.mockResolvedValueOnce({ results: [chapter(1)] });
  await render({
    enabled: canDownloadRequestCopy(MediaType.MANGA, 'downloading'),
    revision: 'downloading:5',
  });

  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(links()).toHaveLength(1);
});
