import PlexAPI from '@server/api/plexapi';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import playback from './playback';

setupTestDb();
beforeEach(async () => {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.plex.machineId = 'test';
  await getRepository(User).update(1, {
    permissions: Permission.ADMIN,
    plexToken: 'test',
  });
  vi.spyOn(PlexAPI.prototype, 'replacePlaylist').mockResolvedValue({
    key: '/playlists/100/items',
  } as never);
});
afterEach(() => vi.restoreAllMocks());
const app = () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = new User({ id: 1 });
    next();
  });
  app.use('/playback', playback);
  return app;
};
describe('collection playback', () => {
  it('plays selected albums as audio and does not include the other audio format', async () => {
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MUSIC,
        tmdbId: 0,
        mbId: '11111111-1111-4111-8111-111111111111',
        status: MediaStatus.AVAILABLE,
        ratingKeyMp3: 'album',
      })
    );
    vi.spyOn(PlexAPI.prototype, 'getMetadata').mockResolvedValue({
      type: 'album',
      ratingKey: 'album',
    } as never);
    vi.spyOn(PlexAPI.prototype, 'getChildrenMetadata').mockResolvedValue([
      {
        type: 'track',
        ratingKey: 'mp3',
        title: 'MP3',
        Media: [{ audioCodec: 'mp3' }],
      },
      {
        type: 'track',
        ratingKey: 'flac',
        title: 'FLAC',
        Media: [{ audioCodec: 'flac' }],
      },
    ] as never);
    expect(
      (
        await request(app())
          .post('/playback/collection/playlist')
          .send({ mediaIds: [media.id], is4k: false })
      ).status
    ).toBe(200);
    expect(PlexAPI.prototype.replacePlaylist).toHaveBeenCalledWith(
      'SeerrNG - Current Selection',
      ['mp3'],
      'audio',
      'test'
    );
  });
  it('filters out 4K-only episodes from an HD series playlist', async () => {
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 55,
        status: MediaStatus.AVAILABLE,
        ratingKey: 'show',
      })
    );
    vi.spyOn(PlexAPI.prototype, 'getMetadata').mockResolvedValue({
      type: 'show',
      ratingKey: 'show',
    } as never);
    vi.spyOn(PlexAPI.prototype, 'getChildrenMetadata').mockImplementation(
      async (id) =>
        id === 'show'
          ? ([
              {
                type: 'season',
                ratingKey: 'season',
                title: 'Season',
                index: 1,
              },
            ] as never)
          : ([
              {
                type: 'episode',
                ratingKey: 'hd',
                title: 'HD',
                Media: [{ videoResolution: '1080' }],
                index: 1,
              },
              {
                type: 'episode',
                ratingKey: '4k',
                title: '4K',
                Media: [{ videoResolution: '4k' }],
                index: 2,
              },
            ] as never)
    );
    expect(
      (
        await request(app())
          .post('/playback/collection/playlist')
          .send({ mediaIds: [media.id], is4k: false })
      ).status
    ).toBe(200);
    expect(PlexAPI.prototype.replacePlaylist).toHaveBeenCalledWith(
      'SeerrNG - Current Selection',
      ['hd'],
      'video',
      'test'
    );
  });
  it('denies playback when the user lacks permissions for the selected media type', async () => {
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MUSIC,
        tmdbId: 0,
        mbId: '11111111-1111-4111-8111-111111111111',
      })
    );
    await getRepository(User).update(1, {
      permissions: Permission.REQUEST_MOVIE,
    });
    expect(
      (
        await request(app())
          .post('/playback/collection/playlist')
          .send({ mediaIds: [media.id] })
      ).status
    ).toBe(403);
    expect(PlexAPI.prototype.replacePlaylist).not.toHaveBeenCalled();
  });
});
