import type { CuratedCollectionMember } from '@server/models/CuratedCollection';
import Link from 'next/link';
import type { ReactNode } from 'react';

export default function CuratedGenreLinks({
  kind,
  parts,
  fallback = '—',
}: {
  kind: 'tv' | 'music';
  parts: Pick<CuratedCollectionMember, 'genres' | 'genreIds'>[];
  fallback?: ReactNode;
}) {
  let genres = [
    ...new Map(
      parts.flatMap((part) =>
        part.genres.map(
          (name, index) => [name, { name, id: part.genreIds?.[index] }] as const
        )
      )
    ).values(),
  ];
  if (kind === 'music') {
    const counts = new Map<string, { name: string; count: number }>();
    for (const part of parts) {
      const seen = new Set<string>();
      for (const name of part.genres) {
        const clean = name.trim();
        const key = clean.toLocaleLowerCase('en');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const genre = counts.get(key) ?? { name: clean, count: 0 };
        genre.count++;
        counts.set(key, genre);
      }
    }
    genres = [...counts.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'en'))
      .slice(0, 6)
      .map(({ name }) => ({ name, id: undefined }));
  }
  if (!genres.length) return <>{fallback}</>;
  return (
    <>
      {genres.map(({ name, id }, index) => {
        const href =
          kind === 'music'
            ? `/discover/music?genre=${encodeURIComponent(name)}`
            : id !== undefined
              ? `/discover/tv?genre=${id}`
              : undefined;
        return (
          <span key={name}>
            {index > 0 && ', '}
            {href ? <Link href={href}>{name}</Link> : name}
          </span>
        );
      })}
    </>
  );
}
