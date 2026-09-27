import axios, { AxiosError } from 'axios';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import useCuratedRatings, { loadCuratedRating } from './useCuratedRatings';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const rating = {
  score: 8,
  votes: 5,
  url: 'https://musicbrainz.org/',
  source: 'musicbrainz',
};
function environment() {
  const dom = new JSDOM('<html><body></body></html>', {
    pretendToBeVisual: true,
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  let current: ReturnType<typeof useCuratedRatings>;
  function Probe({ id, ids }: { id: string; ids: string[] }) {
    current = useCuratedRatings('music', id, ids);
    return null;
  }
  return {
    root,
    Probe,
    read: () => current,
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

it('keeps successful provider values during partial retries and stops once every source responds', async () => {
  const audio = {
    source: 'theaudiodb',
    score: 9,
    votes: 2,
    url: 'https://www.theaudiodb.com/album/1',
  };
  const discogs = {
    source: 'discogs',
    score: 4,
    scale: 5,
    votes: 3,
    url: 'https://www.discogs.com/release/1',
  };
  const get = vi.spyOn(axios, 'get').mockResolvedValue({
    data: { rating, ratings: [rating, audio], failedSources: ['discogs'] },
  });
  const e = environment();
  try {
    await act(async () =>
      e.root.render(<e.Probe id="partial" ids={['album']} />)
    );
    expect(e.read().members[0].failure).toBe('unavailable');
    get.mockResolvedValue({
      data: {
        rating,
        ratings: [rating, discogs],
        failedSources: ['theaudiodb'],
      },
    });
    await act(async () => e.read().retry());
    expect(e.read().members[0].musicRatings).toEqual([rating, audio, discogs]);
    get.mockResolvedValue({
      data: { rating, ratings: [rating, audio, discogs], failedSources: [] },
    });
    await act(async () => e.read().retry());
    expect(e.read().members[0].failure).toBeUndefined();
    await act(async () => e.read().retry());
    expect(get).toHaveBeenCalledTimes(3);
  } finally {
    await e.close();
  }
});

it('preserves successful and absent ratings and retries only failed items', async () => {
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (String(url).includes('/bad/'))
      throw new AxiosError('timeout', 'ECONNABORTED');
    return { data: String(url).includes('/empty/') ? {} : { rating } };
  });
  const e = environment();
  try {
    await act(async () =>
      e.root.render(<e.Probe id="collection" ids={['ok', 'bad', 'empty']} />)
    );
    expect(get).toHaveBeenCalledTimes(3);
    expect(e.read().members.find((m) => m.id === 'ok')?.musicRating).toEqual(
      rating
    );
    expect(e.read().complete).toBe(false);
    expect(e.read().members.find((m) => m.id === 'bad')?.failure).toBe(
      'timeout'
    );
    let finish: (value: unknown) => void = () => undefined;
    get.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await act(async () => {
      void e.read().retry();
      void e.read().retry();
    });
    expect(get).toHaveBeenCalledTimes(4);
    expect(get.mock.calls.at(-1)?.[0]).toBe('/api/v1/music/bad/rating');
    expect(e.read().loading).toBe(true);
    expect(e.read().members.find((m) => m.id === 'ok')?.musicRating).toEqual(
      rating
    );
    await act(async () => finish({ data: { rating } }));
    expect(e.read().loading).toBe(false);
    expect(e.read().members.some((m) => m.failure)).toBe(false);
    expect(e.read().complete).toBe(true);
    await act(async () => e.read().retry());
    expect(get).toHaveBeenCalledTimes(4);
  } finally {
    await e.close();
  }
});

it('stops queued work and ignores old completions when the collection changes', async () => {
  const calls: { signal: AbortSignal; resolve: (value: unknown) => void }[] =
    [];
  vi.spyOn(axios, 'get').mockImplementation(
    (_url, config) =>
      new Promise((resolve) =>
        calls.push({ signal: config!.signal as AbortSignal, resolve })
      )
  );
  const e = environment();
  try {
    await act(async () =>
      e.root.render(<e.Probe id="old" ids={['a', 'b', 'c', 'queued']} />)
    );
    expect(calls).toHaveLength(3);
    await act(async () =>
      e.root.render(<e.Probe id="new" ids={['new-album']} />)
    );
    expect(calls.slice(0, 3).every((c) => c.signal.aborted)).toBe(true);
    await act(async () => {
      for (const call of calls.slice(0, 3)) call.resolve({ data: { rating } });
    });
    expect(calls).toHaveLength(4);
    expect(e.read().members).toEqual([]);
    await act(async () => calls[3].resolve({ data: { rating } }));
    expect(e.read().members.map((m) => m.id)).toEqual(['new-album']);
  } finally {
    await e.close();
  }
  expect(calls[3].signal.aborted).toBe(true);
});

it('loads at most 50 collection ratings per batch and preserves completed results when ids change', async () => {
  let finishLast: (value: unknown) => void = () => undefined;
  const get = vi.spyOn(axios, 'get').mockImplementation((url) =>
    String(url).includes('/album-49/')
      ? new Promise((resolve) => {
          finishLast = resolve;
        })
      : Promise.resolve({ data: { rating } })
  );
  const e = environment();
  const ids = Array.from({ length: 51 }, (_, index) => `album-${index}`);
  try {
    await act(async () => e.root.render(<e.Probe id="batched" ids={ids} />));
    expect(get).toHaveBeenCalledTimes(50);
    expect(e.read().complete).toBe(false);
    await act(async () => finishLast({ data: { rating } }));
    expect(get).toHaveBeenCalledTimes(51);
    expect(e.read().complete).toBe(true);
    await act(async () =>
      e.root.render(<e.Probe id="batched" ids={ids.slice(0, 10)} />)
    );
    await act(async () => e.root.render(<e.Probe id="batched" ids={ids} />));
    expect(get).toHaveBeenCalledTimes(51);
  } finally {
    await e.close();
  }
});

it('quietly retries failures with backoff while preserving successes, then stops after recovery', async () => {
  vi.useFakeTimers();
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (String(url).includes('/bad/'))
      throw new AxiosError('timeout', 'ECONNABORTED');
    return { data: { rating } };
  });
  const e = environment();
  try {
    await act(async () =>
      e.root.render(<e.Probe id="auto" ids={['ok', 'bad']} />)
    );
    for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
      const count = get.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay - 1);
      });
      expect(get).toHaveBeenCalledTimes(count);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(get).toHaveBeenCalledTimes(count + 1);
      expect(get.mock.calls.at(-1)?.[0]).toBe('/api/v1/music/bad/rating');
      expect(
        e.read().members.find((member) => member.id === 'ok')?.musicRating
      ).toEqual(rating);
    }
    get.mockResolvedValue({ data: { rating } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300000);
    });
    const count = get.mock.calls.length;
    expect(e.read().members.some((member) => member.failure)).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600000);
    });
    expect(get).toHaveBeenCalledTimes(count);
  } finally {
    await e.close();
  }
});

it('pauses retries while hidden or offline and cancels its timer on unmount', async () => {
  vi.useFakeTimers();
  const get = vi
    .spyOn(axios, 'get')
    .mockRejectedValue(new AxiosError('timeout', 'ECONNABORTED'));
  const e = environment();
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  const online = vi
    .spyOn(window.navigator, 'onLine', 'get')
    .mockReturnValue(true);
  try {
    await act(async () => e.root.render(<e.Probe id="paused" ids={['bad']} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90000);
    });
    expect(get).toHaveBeenCalledTimes(1);
    hidden.mockReturnValue(false);
    online.mockReturnValue(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(get).toHaveBeenCalledTimes(1);
    online.mockReturnValue(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(get).toHaveBeenCalledTimes(2);
  } finally {
    await e.close();
  }
  await vi.advanceTimersByTimeAsync(600000);
  expect(get).toHaveBeenCalledTimes(2);
});

it.each(['music', 'tv'] as const)(
  'treats confirmed absent %s ratings as non-errors',
  async (kind) => {
    vi.spyOn(axios, 'get').mockRejectedValue({
      isAxiosError: true,
      response: { status: 404 },
    });
    expect(
      await loadCuratedRating(kind, 'id', new AbortController().signal)
    ).toEqual({ id: 'id' });
  }
);
it.each([
  [429, 'busy'],
  [401, 'authentication'],
  [403, 'authentication'],
  [503, 'unavailable'],
] as const)(
  'classifies HTTP %s without exposing technical response text',
  async (status, failure) => {
    vi.spyOn(axios, 'get').mockRejectedValue({
      isAxiosError: true,
      response: { status },
    });
    expect(
      await loadCuratedRating('music', 'id', new AbortController().signal)
    ).toEqual({ id: 'id', failure });
  }
);
