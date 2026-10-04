import type { MangaResult } from '@server/models/Manga';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MangaTitleCard from './MangaTitleCard';

const state = vi.hoisted(() => ({
  batches: [] as (readonly number[])[],
  summaries: new Map<number, unknown>(),
  isLoading: false,
  error: undefined as unknown,
}));
vi.mock('@app/hooks/useMangaSummaries', () => ({
  default: (ids: readonly number[]) => {
    state.batches.push(ids);
    return {
      summaries: state.summaries,
      isLoading: state.isLoading,
      error: state.error,
    };
  },
}));
vi.mock('@app/components/TitleCard', () => {
  const Card = ({
    id,
    image,
    status,
    title,
    year,
    mediaType,
    isAddedToWatchlist,
  }: {
    id: number;
    image?: string;
    status?: number;
    title: string;
    year?: string;
    mediaType: string;
    isAddedToWatchlist?: number | boolean;
  }) => (
    <div
      data-testid="card"
      data-id={id}
      data-image={image}
      data-status={status}
      data-title={title}
      data-year={year}
      data-media-type={mediaType}
      data-watchlisted={String(isAddedToWatchlist)}
    />
  );
  Card.Placeholder = () => <div data-testid="placeholder" />;
  return { default: Card };
});

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
  state.batches = [];
  state.summaries = new Map();
  state.isLoading = false;
  state.error = undefined;
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () =>
    root.render(<MangaTitleCard id={30013} batchIds={[30013, 30014]} />)
  );
};

it('renders the watchlisted manga from its batch with the proxied poster', async () => {
  state.summaries = new Map([
    [
      30013,
      {
        id: 30013,
        title: 'Sample Manga',
        posterPath: 'https://s4.anilist.co/file/cover.jpg',
        startYear: 1994,
        mediaInfo: { status: 5 },
      } as unknown as MangaResult,
    ],
  ]);
  await render();

  expect(state.batches).toContainEqual([30013, 30014]);
  const card = host.querySelector('[data-testid="card"]');
  expect(card?.getAttribute('data-id')).toBe('30013');
  expect(card?.getAttribute('data-image')).toBe(
    '/imageproxy/anilist/file/cover.jpg'
  );
  expect(card?.getAttribute('data-status')).toBe('5');
  expect(card?.getAttribute('data-title')).toBe('Sample Manga');
  expect(card?.getAttribute('data-year')).toBe('1994');
  expect(card?.getAttribute('data-media-type')).toBe('manga');
  expect(card?.getAttribute('data-watchlisted')).toBe('true');
});

it("marks the card from the viewer's own watchlist entries", async () => {
  state.summaries = new Map([
    [
      30013,
      { id: 30013, title: 'Sample Manga', mediaInfo: { watchlists: [] } },
    ],
  ]);
  await render();

  expect(
    host.querySelector('[data-testid="card"]')?.getAttribute('data-watchlisted')
  ).toBe('0');
});

it.each([
  ['while the batch loads', true, undefined],
  ['when the batch fails', false, new Error('unavailable')],
])('shows a placeholder %s', async (_case, isLoading, error) => {
  state.isLoading = isLoading;
  state.error = error;
  await render();

  expect(host.querySelector('[data-testid="placeholder"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="card"]')).toBeNull();
});

it('leaves out a title that is unknown or hidden by the content settings', async () => {
  state.summaries = new Map([[30014, { id: 30014 }]]);
  await render();

  expect(host.innerHTML).toBe('');
});
