import ExternalAPI from '@server/api/externalapi';
import type { MbLink } from '@server/api/musicbrainz/interfaces';
import TheAudioDb, { conciseArtistBiography } from '@server/api/theaudiodb';
import cacheManager from '@server/lib/cache';

class Wikipedia extends ExternalAPI {
  constructor() {
    super(
      'https://en.wikipedia.org/api/rest_v1',
      {},
      {
        nodeCache: cacheManager.getCache('wikidata').data,
        timeout: 5000,
        headers: {
          'User-Agent': 'SeerrNG/1.0 (https://github.com/JohnCronk79/seerrng)',
        },
      }
    );
  }
  async summary(title: string) {
    return this.get<{ type?: string; extract?: string }>(
      '/page/summary/' + encodeURIComponent(title),
      undefined,
      43200
    );
  }
}
class Wikidata extends ExternalAPI {
  constructor() {
    super(
      'https://www.wikidata.org/w',
      {},
      {
        nodeCache: cacheManager.getCache('wikidata').data,
        timeout: 5000,
        headers: {
          'User-Agent': 'SeerrNG/1.0 (https://github.com/JohnCronk79/seerrng)',
        },
      }
    );
  }
  async title(id: string): Promise<string | undefined> {
    const data = await this.get<{
      entities?: Record<
        string,
        { sitelinks?: { enwiki?: { title?: string } } }
      >;
    }>(
      '/api.php',
      {
        params: {
          action: 'wbgetentities',
          ids: id,
          props: 'sitelinks',
          sitefilter: 'enwiki',
          format: 'json',
        },
      },
      43200
    );
    return data.entities?.[id]?.sitelinks?.enwiki?.title;
  }
}
export { Wikidata, Wikipedia };

export async function getArtistOverview(id: string, links: MbLink[] = []) {
  try {
    let title: string | undefined;
    for (const link of links) {
      let url: URL;
      try {
        url = new URL(link.target);
      } catch {
        continue;
      }
      if (url.protocol !== 'https:' || url.username || url.password || url.port)
        continue;
      if (
        link.type === 'wikipedia' &&
        url.hostname === 'en.wikipedia.org' &&
        url.pathname.startsWith('/wiki/')
      ) {
        title = decodeURIComponent(url.pathname.slice(6));
        break;
      }
      if (
        link.type === 'wikidata' &&
        ['wikidata.org', 'www.wikidata.org'].includes(url.hostname)
      ) {
        const item = /^\/wiki\/(Q[1-9]\d*)$/.exec(url.pathname)?.[1];
        if (item) title = await new Wikidata().title(item);
      }
    }
    if (title && title.length < 512) {
      const data = await new Wikipedia().summary(title);
      const text = conciseArtistBiography(data.extract);
      if (text && data.type !== 'disambiguation')
        return {
          text,
          source: {
            name: 'Wikipedia',
            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`,
          },
        };
    }
  } catch {
    /* An optional biography must never prevent browsing albums. */
  }
  const fallback = await new TheAudioDb()
    .getArtistOverview(id)
    .catch(() => null);
  return fallback
    ? { text: fallback.text, source: { name: 'TheAudioDB', url: fallback.url } }
    : null;
}
