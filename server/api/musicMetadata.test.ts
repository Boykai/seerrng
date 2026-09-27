import { afterEach, expect, it, vi } from 'vitest';
import { getArtistOverview, Wikidata, Wikipedia } from './artistOverview';
import Discogs from './discogs';
import { sanitizeMusicBrainzAlbum } from './musicbrainz';
import TheAudioDb, { conciseArtistBiography } from './theaudiodb';

afterEach(() => vi.restoreAllMocks());
it.each(['Album', 'EP', 'Single', 'Broadcast', 'Other'])(
  'preserves the universal primary release type %s',
  (type) => {
    expect(
      sanitizeMusicBrainzAlbum({
        id: '79239441-bfd5-4981-a70c-55c3f15c1287',
        title: 'Example',
        'primary-type': type,
      })?.['primary-type']
    ).toBe(type);
  }
);
it('spaces public Discogs calls below 25 requests per minute', () => {
  const limiter = Reflect.get(new Discogs(), 'axios') as {
    getMaxRPS(): number;
  };
  expect(limiter.getMaxRPS()).toBe(0.4);
});
const id = '79239441-bfd5-4981-a70c-55c3f15c1287';
const fakeGet = (client: object) => {
  const get = vi.fn();
  Object.defineProperty(client, 'get', { value: get });
  return get;
};

it('requests a matching artist and accepts both current and legacy biography fields', async () => {
  const api = new TheAudioDb(),
    get = fakeGet(api);
  for (const field of ['strBiography', 'strBiographyEN']) {
    get.mockResolvedValue({
      artists: [
        {
          idArtist: '111255',
          strMusicBrainzID: id,
          [field]: 'An influential pop artist. A long career.',
        },
      ],
    });
    expect(await api.getArtistOverview(id)).toEqual({
      text: 'An influential pop artist. A long career.',
      url: 'https://www.theaudiodb.com/artist/111255',
    });
  }
  get.mockResolvedValue({
    artists: [
      {
        idArtist: '111255',
        strMusicBrainzID: 'other',
        strBiography: 'Wrong artist.',
      },
    ],
  });
  expect(await api.getArtistOverview(id)).toBeNull();
});
it('caps biographies to three sentences and the approved 475-character example and removes markup/scripts', () => {
  expect(
    conciseArtistBiography(
      '<script>bad()</script><p>First sentence. Second sentence. Third sentence. Fourth sentence.</p>'
    )
  ).toBe('First sentence. Second sentence. Third sentence.');
  expect(
    conciseArtistBiography('A career ' + 'long '.repeat(300)).length
  ).toBeLessThanOrEqual(475);
  expect(conciseArtistBiography('x'.repeat(1000)).length).toBeLessThanOrEqual(
    475
  );
  expect(conciseArtistBiography(null)).toBe('');
});
it('uses MusicBrainz-linked Wikidata identity, not an artist-name guess', async () => {
  const title = vi
    .spyOn(Wikidata.prototype, 'title')
    .mockResolvedValue('Madonna');
  const summary = vi.spyOn(Wikipedia.prototype, 'summary').mockResolvedValue({
    type: 'standard',
    extract: 'An influential singer. Known for pop music.',
  });
  const fallback = vi.spyOn(TheAudioDb.prototype, 'getArtistOverview');
  const result = await getArtistOverview(id, [
    { type: 'wikidata', target: 'https://www.wikidata.org/wiki/Q1744' },
  ]);
  expect(title).toHaveBeenCalledWith('Q1744');
  expect(summary).toHaveBeenCalledWith('Madonna');
  expect(result?.source.name).toBe('Wikipedia');
  expect(fallback).not.toHaveBeenCalled();
});
it('rejects unsafe source URLs and falls back without breaking the catalogue', async () => {
  const title = vi.spyOn(Wikidata.prototype, 'title');
  vi.spyOn(TheAudioDb.prototype, 'getArtistOverview').mockResolvedValue({
    text: 'A short career summary.',
    url: 'https://www.theaudiodb.com/artist/111255',
  });
  expect(
    (
      await getArtistOverview(id, [
        {
          type: 'wikidata',
          target: 'https://www.wikidata.org.evil.test/wiki/Q1744',
        },
      ])
    )?.source.name
  ).toBe('TheAudioDB');
  expect(title).not.toHaveBeenCalled();
  vi.spyOn(TheAudioDb.prototype, 'getArtistOverview').mockRejectedValue(
    new Error('offline')
  );
  expect(await getArtistOverview(id)).toBeNull();
});
it('validates AudioDB identity, scale and votes instead of inventing missing scores', async () => {
  const api = new TheAudioDb(),
    get = fakeGet(api);
  const album = {
    idAlbum: '2109828',
    strMusicBrainzID: id,
    intScore: '9',
    intScoreVotes: '2',
  };
  get.mockResolvedValue({ album: [album] });
  expect(await api.getAlbumRating(id)).toMatchObject({
    source: 'theaudiodb',
    score: 9,
    votes: 2,
    scale: 10,
  });
  for (const patch of [
    { intScore: 'NaN' },
    { intScore: '11' },
    { intScoreVotes: '0' },
    { strMusicBrainzID: 'other' },
  ]) {
    get.mockResolvedValue({ album: [{ ...album, ...patch }] });
    expect(await api.getAlbumRating(id)).toBeUndefined();
  }
});
it('uses the exact Discogs master main release and keeps its native 5-point scale', async () => {
  const api = new Discogs(),
    get = fakeGet(api);
  get
    .mockResolvedValueOnce({ id: 67803, main_release: 249504 })
    .mockResolvedValueOnce({
      release_id: 249504,
      rating: { average: 4.5, count: 20 },
    });
  expect(
    await api.getAlbumRating([
      { type: 'discogs', target: 'https://www.discogs.com/master/67803' },
    ])
  ).toMatchObject({
    source: 'discogs',
    score: 4.5,
    scale: 5,
    votes: 20,
    edition: 'main-release',
  });
  expect(get.mock.calls.map((call) => call[0])).toEqual([
    '/masters/67803',
    '/releases/249504/rating',
  ]);
});
it('does not request untrusted Discogs targets or fabricate ratings for unlinked albums', async () => {
  const api = new Discogs(),
    get = fakeGet(api);
  expect(
    await api.getAlbumRating([
      { type: 'discogs', target: 'https://discogs.com.evil.test/master/1' },
    ])
  ).toBeUndefined();
  expect(await api.getAlbumRating([])).toBeUndefined();
  expect(get).not.toHaveBeenCalled();
});
it('sanitizes genre lists and provider relations from MusicBrainz', () => {
  const album = sanitizeMusicBrainzAlbum({
    id,
    title: 'Album',
    genres: [{ name: 'pop', count: 3 }, null],
    relations: [
      {
        type: 'discogs',
        url: { resource: 'https://www.discogs.com/master/67803' },
      },
    ],
  });
  expect(album?.genres).toEqual([{ name: 'pop', count: 3 }]);
  expect(album?.links).toEqual([
    { type: 'discogs', target: 'https://www.discogs.com/master/67803' },
  ]);
});
