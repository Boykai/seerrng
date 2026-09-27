import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import MusicArtistSelector from './MusicArtistSelector';

const state = vi.hoisted(() => ({
  props: {} as Record<string, any>,
  update: vi.fn(),
  get: vi.fn(),
  query: {
    artist: 'Madonna',
    artistId: '79239441-bfd5-4981-a70c-55c3f15c1287',
  },
}));
vi.mock('next/router', () => ({ useRouter: () => ({ query: state.query }) }));
vi.mock('@app/hooks/useUpdateQueryParams', () => ({
  useBatchUpdateQueryParams: () => state.update,
}));
vi.mock('@app/hooks/useDiscover', () => ({
  encodeURIExtraParams: encodeURIComponent,
}));
vi.mock('@app/components/Selector', () => ({ compactSelectComponents: {} }));
vi.mock('react-intl', () => ({
  defineMessages: (messages: unknown) => messages,
  useIntl: () => ({
    formatMessage: (message: { defaultMessage: string }) =>
      message.defaultMessage,
  }),
}));
vi.mock('axios', () => ({ default: { get: state.get } }));
vi.mock('react-select/async', () => ({
  default: (props: Record<string, any>) => {
    state.props = props;
    return null;
  },
}));
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  vi.useFakeTimers();
});
it('debounces live artist lookup and returns named, disambiguated artist options', async () => {
  state.get.mockResolvedValue({
    data: {
      results: [
        {
          id: 'id',
          name: 'Madonna',
          mediaType: 'artist',
          disambiguation: 'US singer',
        },
        { id: 'album', title: 'Madonna', mediaType: 'album' },
      ],
    },
  });
  renderToStaticMarkup(<MusicArtistSelector />);
  const callback = vi.fn();
  state.props.loadOptions('M', callback);
  state.props.loadOptions('Mad', callback);
  await vi.advanceTimersByTimeAsync(350);
  expect(state.get).toHaveBeenCalledTimes(1);
  expect(state.get).toHaveBeenCalledWith('/api/v1/search', {
    params: { query: 'Mad', type: 'artist' },
  });
  expect(callback).toHaveBeenCalledWith([
    { value: 'id', name: 'Madonna', label: 'Madonna (US singer)' },
  ]);
  vi.useRealTimers();
});
it('stores the exact selection and clears both name and ID without discarding other filters', () => {
  renderToStaticMarkup(<MusicArtistSelector />);
  state.props.onChange({ name: 'Madonna', value: 'id' });
  expect(state.update).toHaveBeenLastCalledWith({
    artist: 'Madonna',
    artistId: 'id',
    page: undefined,
  });
  state.props.onChange(null);
  expect(state.update).toHaveBeenLastCalledWith({
    artist: undefined,
    artistId: undefined,
    page: undefined,
  });
  vi.useRealTimers();
});
