import axios from 'axios';
import { JSDOM } from 'jsdom';
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import useAlbumArtwork, { fetchAlbumArtwork } from './useAlbumArtwork';

const state = vi.hoisted(() => ({
  keys: [] as unknown[],
  data: undefined as undefined | { posterPath: string },
}));
vi.mock('swr', () => ({
  default: (key: unknown) => {
    state.keys.push(key);
    return { data: key ? state.data : undefined };
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  state.keys.length = 0;
});
it('does not fetch offscreen, non-music or already illustrated cards', () => {
  vi.stubGlobal('React', React);
  function Probe({ id, poster }: { id?: string; poster?: string }) {
    const cover = useAlbumArtwork(id, poster, { current: null });
    return <span>{cover}</span>;
  }
  renderToStaticMarkup(<Probe id="album" />);
  renderToStaticMarkup(<Probe />);
  expect(
    renderToStaticMarkup(<Probe id="album" poster="existing.jpg" />)
  ).toContain('existing.jpg');
  expect(state.keys).toEqual([null, null, null]);
});
it('limits concurrent artwork lookups and releases queue slots after failures', async () => {
  const pending: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  const get = vi
    .spyOn(axios, 'get')
    .mockImplementation(
      () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
    );
  const requests = Array.from({ length: 6 }, (_, i) =>
    fetchAlbumArtwork(`/artwork/${i}`)
  );
  const all = Promise.allSettled(requests);
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4));
  pending[0].reject(new Error('temporary'));
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(5));
  pending[1].resolve({ data: { posterPath: 'cover.jpg' } });
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(6));
  for (const entry of pending.slice(2))
    entry.resolve({ data: { posterPath: null } });
  const results = await all;
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
});

it('hydrates a missing visible cover and disconnects the visibility observer', async () => {
  const dom = new JSDOM('<html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let enter: (entries: { isIntersecting: boolean }[]) => void = () => undefined;
  const disconnect = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof enter) {
        enter = callback;
      }
      observe() {}
      disconnect = disconnect;
    }
  );
  state.data = { posterPath: 'resolved.jpg' };
  function Probe() {
    const ref = useRef<HTMLDivElement>(null);
    const cover = useAlbumArtwork('album', undefined, ref);
    return <div ref={ref}>{cover}</div>;
  }
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<Probe />));
    expect(state.keys.at(-1)).toBeNull();
    await act(async () => enter([{ isIntersecting: true }]));
    expect(state.keys.at(-1)).toBe('/api/v1/music/album/artwork');
    expect(node.textContent).toBe('resolved.jpg');
    expect(disconnect).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
