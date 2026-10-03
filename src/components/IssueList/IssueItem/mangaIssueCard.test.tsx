import type * as MediaTypeBadgeModule from '@app/components/Common/MediaTypeBadge';
import { IssueStatus, IssueType } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import type Issue from '@server/entity/Issue';
import type { MangaDetails } from '@server/models/Manga';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { beforeEach, expect, it, vi } from 'vitest';
import IssueItem from './index';

const state = vi.hoisted(() => ({
  keys: [] as (string | null)[],
  title: undefined as unknown,
}));

vi.mock('swr', () => ({
  mutate: vi.fn(),
  default: (key: string | null) => {
    state.keys.push(key);
    return key === '/api/v1/manga/9001' ? { data: state.title } : {};
  },
}));
vi.mock('react-intersection-observer', () => ({
  useInView: () => ({ ref: () => {}, inView: true }),
}));
vi.mock('@app/hooks/useUser', () => ({
  Permission: { MANAGE_ISSUES: 1, VIEW_ISSUES: 2 },
  useUser: () => ({ hasPermission: () => true }),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock('@app/components/Common/CachedImage', () => ({
  default: ({ src, type }: { src: string; type: string }) => (
    <span data-src={src} data-image-type={type} />
  ),
}));
vi.mock('@app/components/Common/MediaTypeBadge', async (importOriginal) => ({
  ...(await importOriginal<typeof MediaTypeBadgeModule>()),
  default: ({ mediaType }: { mediaType: string }) => (
    <span data-badge={mediaType} />
  ),
}));

const manga = (values: Partial<MangaDetails> = {}): Partial<MangaDetails> => ({
  id: 9001,
  mediaType: 'manga',
  provider: 'anilist',
  title: 'Sample Manga',
  chapters: 1200,
  posterPath: 'https://s4.anilist.co/file/cover.jpg',
  backdropPath: 'https://s4.anilist.co/file/banner.jpg',
  genres: [],
  startYear: 1994,
  startDate: '1994-07-22',
  ...values,
});

const render = ({
  embedded = false,
  identifiers = [{ provider: 'anilist', value: '9001' }],
}: {
  embedded?: boolean;
  identifiers?: { provider: string; value: string }[];
} = {}) =>
  renderToStaticMarkup(
    <IntlProvider locale="en">
      <IssueItem
        embedded={embedded}
        issue={
          {
            id: 7,
            status: IssueStatus.OPEN,
            issueType: IssueType.OTHER,
            is4k: false,
            createdAt: '2026-09-20T12:00:00Z',
            createdBy: { id: 1, displayName: 'Test User' },
            media: { id: 11, mediaType: MediaType.MANGA, identifiers },
            comments: [{ message: 'Pages are missing' }],
          } as unknown as Issue
        }
      />
    </IntlProvider>
  );

const detailValue = (html: string, label: string) =>
  html.match(new RegExp(`${label}:</dt><dd[^>]*>([^<]*)</dd>`))?.[1];

beforeEach(() => {
  vi.stubGlobal('React', React);
  state.keys = [];
  state.title = manga();
});

it('loads a manga issue by its AniList id and links to the manga page', () => {
  const html = render();

  expect(state.keys).toContain('/api/v1/manga/9001');
  expect(html).not.toContain('Media Not Found');
  expect(html).toContain('Sample Manga (1994)');
  expect(html).toContain('href="/manga/9001"');
  expect(html).toContain('data-badge="manga"');
  expect(detailValue(html, 'Media &amp; Format')).toBe('Manga');
  expect(detailValue(html, 'First Published')).toBe('1994-07-22');
  expect(detailValue(html, 'Chapters')).toBe('1,200');
  expect(detailValue(html, 'Type')).toBe('Other');
  expect(detailValue(html, 'Description')).toBe('Pages are missing');
  expect(html).not.toContain('Reason:');
});

it('loads manga artwork only through the AniList image proxy', () => {
  const html = render();

  expect(html).toContain(
    'data-src="/imageproxy/anilist/file/cover.jpg" data-image-type="tmdb"'
  );
  expect(html).toContain(
    'data-src="/imageproxy/anilist/file/banner.jpg" data-image-type="tmdb"'
  );
  expect(html).not.toContain('s4.anilist.co');
});

it('falls back to the placeholder poster for missing or untrusted artwork', () => {
  state.title = manga({
    posterPath: 'https://images.example.test/cover.jpg',
    backdropPath: undefined,
    chapters: undefined,
    startDate: undefined,
  });
  const html = render();

  expect(html).toContain('data-src="/images/seerr_poster_not_found.png"');
  expect(html).not.toContain('images.example.test');
  expect(html).not.toContain('refreshed-artwork-scrim');
  expect(html).toContain('Sample Manga (1994)');
  expect(detailValue(html, 'First Published')).toBe('1994');
  expect(detailValue(html, 'Chapters')).toBe('Not available');
});

it('shows media not found when a manga issue has no AniList id', () => {
  const html = render({ identifiers: [] });

  expect(state.keys).not.toContain('/api/v1/manga/9001');
  expect(html).toContain('Media Not Found');
});
