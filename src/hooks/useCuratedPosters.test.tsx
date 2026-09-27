import type { CuratedCollectionMember } from '@server/models/CuratedCollection';
import axios from 'axios';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import useCuratedPosters from './useCuratedPosters';

vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: { cacheImages: false } }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('retains cached posters, retries only failures, and keeps loading until image downloads succeed', async () => {
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const started: string[] = [];
  let imageFails = true;
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      started.push(value);
      queueMicrotask(() =>
        value.endsWith('/bad') && imageFails
          ? this.onerror?.()
          : this.onload?.()
      );
    }
  }
  Object.defineProperty(dom.window, 'Image', {
    value: FakeImage,
    configurable: true,
  });
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (String(url).includes('/bad/'))
      throw new Error('temporary provider timeout');
    return { data: { posterPath: null } };
  });
  const parts = [
    { id: 'ok', posterPath: 'https://coverartarchive.org/ok' },
    { id: 'bad' },
    { id: 'absent' },
  ] as CuratedCollectionMember[];
  let current!: ReturnType<typeof useCuratedPosters>;
  function Probe() {
    current = useCuratedPosters('retry-collection', parts);
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<Probe />));
    expect(current.complete).toBe(false);
    expect(current.loading).toBe(false);
    expect(current.posters).toEqual({ ok: parts[0].posterPath, absent: null });
    get.mockResolvedValue({
      data: { posterPath: 'https://coverartarchive.org/bad' },
    });
    await act(async () => current.retry());
    expect(current.complete).toBe(false);
    expect(get).toHaveBeenCalledTimes(3);
    imageFails = false;
    await act(async () => current.retry());
    expect(current.complete).toBe(true);
    expect(get).toHaveBeenCalledTimes(3);
    expect(started.filter((url) => url.endsWith('/ok'))).toHaveLength(1);
    expect(current.posters.bad).toBe('https://coverartarchive.org/bad');
    await act(async () => current.retry());
    expect(started).toHaveLength(3);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

it('preloads posters in groups of 50 without waiting for scroll or restarting on re-render', async () => {
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const started: string[] = [];
  let finishLast: () => void = () => undefined;
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      started.push(value);
      if (value.endsWith('/49')) finishLast = () => this.onload?.();
      else queueMicrotask(() => this.onload?.());
    }
  }
  Object.defineProperty(dom.window, 'Image', {
    value: FakeImage,
    configurable: true,
  });
  const parts = Array.from({ length: 51 }, (_, index) => ({
    id: `album-${index}`,
    posterPath: `https://coverartarchive.org/${index}`,
  })) as CuratedCollectionMember[];
  let current!: ReturnType<typeof useCuratedPosters>;
  function Probe({ members }: { members: CuratedCollectionMember[] }) {
    current = useCuratedPosters('collection', members);
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<Probe members={parts} />));
    expect(started).toHaveLength(50);
    expect(current.loading).toBe(true);
    expect(current.complete).toBe(false);
    await act(async () => finishLast());
    expect(started).toHaveLength(51);
    expect(current.complete).toBe(true);
    expect(current.loading).toBe(false);
    await act(async () => root.render(<Probe members={[...parts]} />));
    expect(started).toHaveLength(51);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
