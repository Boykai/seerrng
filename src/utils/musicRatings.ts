import type { MusicRating } from '@server/models/Music';

export type DisplayMusicRating = MusicRating & { ratedAlbums?: number };
export function averageMusicRatings(
  albums: MusicRating[][]
): DisplayMusicRating[] {
  const groups = new Map<MusicRating['source'], MusicRating[]>();
  for (const album of albums) {
    for (const rating of new Map(
      album.map((value) => [value.source, value])
    ).values()) {
      if (
        !Number.isFinite(rating.score) ||
        rating.score < 0 ||
        rating.score > (rating.scale ?? 10) ||
        rating.votes <= 0
      )
        continue;
      const group = groups.get(rating.source) ?? [];
      group.push(rating);
      groups.set(rating.source, group);
    }
  }
  return [...groups].map(([source, values]) => ({
    source,
    score: values.reduce((sum, value) => sum + value.score, 0) / values.length,
    scale: values[0].scale ?? 10,
    votes: values.reduce((sum, value) => sum + value.votes, 0),
    url: '',
    ratedAlbums: values.length,
  }));
}
