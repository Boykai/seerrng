import ExternalAPI from '@server/api/externalapi';
import TheAudioDb from '@server/api/theaudiodb';
import cacheManager from '@server/lib/cache';
import { normalizeMusicBrainzId } from '@server/lib/externalIds';

type ArtistArtworkResponse = {
  id?: string;
  images?: { CoverType?: string; remoteUrl?: string }[];
};

export const artistPosterFromMetadata = (
  data: ArtistArtworkResponse,
  artistId: string
): string | undefined => {
  if (data.id?.toLowerCase() !== artistId || !Array.isArray(data.images))
    return undefined;
  for (const image of data.images) {
    if (image?.CoverType?.toLowerCase() !== 'poster' || !image.remoteUrl)
      continue;
    try {
      const url = new URL(image.remoteUrl);
      if (
        url.protocol === 'https:' &&
        url.hostname === 'assets.fanart.tv' &&
        !url.username &&
        !url.password &&
        !url.port &&
        url.pathname.startsWith('/fanart/')
      )
        return url.href;
    } catch {
      // Ignore malformed provider artwork rather than blocking the collection.
    }
  }
  return undefined;
};

export class ArtistArtworkMetadata extends ExternalAPI {
  constructor() {
    super(
      'https://api.lidarr.audio/api/v0.4',
      {},
      {
        nodeCache: cacheManager.getCache('lidarr').data,
        timeout: 5000,
      }
    );
  }

  async poster(id: string) {
    const artistId = normalizeMusicBrainzId(id);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(artistId))
      return undefined;
    const data = await this.get<ArtistArtworkResponse>(
      `/artist/${artistId}`,
      undefined,
      86400
    );
    return artistPosterFromMetadata(data, artistId);
  }
}

export async function getArtistPoster(id: string): Promise<string | undefined> {
  const artistId = normalizeMusicBrainzId(id);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(artistId))
    return undefined;
  try {
    const poster = await new ArtistArtworkMetadata().poster(artistId);
    if (poster) return poster;
  } catch {
    // Optional metadata must not prevent browsing the artist's collection.
  }
  const fallback = await new TheAudioDb()
    .getArtistImages(artistId)
    .catch(() => null);
  return fallback?.artistThumb ?? undefined;
}
