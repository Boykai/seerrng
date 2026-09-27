import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { expect, it } from 'vitest';
import AlbumTrackList from './AlbumTrackList';

const tracks = [
  {
    name: 'First song',
    position: 1,
    length: 180000,
    recordingMbid: 'first',
    totalListenCount: 0,
    totalUserCount: 0,
    artists: [],
  },
  {
    name: 'Second song',
    position: 2,
    length: 210000,
    recordingMbid: 'second',
    totalListenCount: 0,
    totalUserCount: 0,
    artists: [],
  },
];

it('shows the whole album as included without offering unsupported track requests', () => {
  const markup = renderToStaticMarkup(
    <IntlProvider locale="en">
      <AlbumTrackList tracks={tracks} albumRequest twoColumnsOnly />
    </IntlProvider>
  );

  expect(markup.match(/aria-pressed="true"/g)).toHaveLength(3);
  expect(markup.match(/disabled=""/g)).toHaveLength(3);
  expect(markup).toContain('Included in the album request');
  expect(markup).not.toContain('Green check: available');
});
