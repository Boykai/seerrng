import ExternalAPI from '@server/api/externalapi';
import type { MbLink } from '@server/api/musicbrainz/interfaces';
import cacheManager from '@server/lib/cache';
import type { MusicRating } from '@server/models/Music';

export default class Discogs extends ExternalAPI {
  constructor() {
    super(
      'https://api.discogs.com',
      {},
      {
        nodeCache: cacheManager.getCache('musicbrainz').data,
        timeout: 5000,
        headers: {
          'User-Agent': 'SeerrNG/1.0 (https://github.com/JohnCronk79/seerrng)',
        },
        rateLimit: { maxRequests: 1, perMilliseconds: 2500 },
      }
    );
  }
  async getAlbumRating(links: MbLink[] = []): Promise<MusicRating | undefined> {
    for (const link of links) {
      if (link.type !== 'discogs') continue;
      let url: URL;
      try {
        url = new URL(link.target);
      } catch {
        continue;
      }
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        !['discogs.com', 'www.discogs.com'].includes(url.hostname) ||
        url.port ||
        url.username ||
        url.password
      )
        continue;
      const match = /^\/(master|release)\/([1-9]\d*)(?:-[^/]*)?\/?$/.exec(
        url.pathname
      );
      if (!match) continue;
      let releaseId = Number(match[2]);
      const fromMaster = match[1] === 'master';
      if (fromMaster) {
        const master = await this.get<{ id: number; main_release: number }>(
          `/masters/${releaseId}`,
          undefined,
          43200
        );
        if (master.id !== releaseId)
          throw new Error('Discogs master identity mismatch');
        releaseId = master.main_release;
      }
      if (!Number.isSafeInteger(releaseId) || releaseId <= 0)
        throw new Error('Invalid Discogs release identity');
      const data = await this.get<{
        release_id: number;
        rating: { average: number; count: number };
      }>(`/releases/${releaseId}/rating`, undefined, 43200);
      if (data.release_id !== releaseId)
        throw new Error('Discogs release identity mismatch');
      const score = data.rating?.average,
        votes = data.rating?.count;
      if (
        !Number.isFinite(score) ||
        score < 0 ||
        score > 5 ||
        !Number.isSafeInteger(votes) ||
        votes <= 0
      )
        return undefined;
      return {
        source: 'discogs',
        score,
        votes,
        scale: 5,
        url: `https://www.discogs.com/release/${releaseId}`,
        edition: fromMaster ? 'main-release' : 'linked-release',
      };
    }
    return undefined;
  }
}
