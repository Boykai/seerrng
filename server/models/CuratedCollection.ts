import type Media from '@server/entity/Media';

export type CollectionKind = 'movie' | 'tv' | 'music';
export interface CuratedCollectionMember {
  id: string;
  title: string;
  releaseDate: string;
  originalLanguage?: string;
  status?: string;
  posterPath?: string;
  overview?: string;
  subtitle?: string;
  primaryType?: string;
  secondaryTypes?: string[];
  runtime?: number;
  network?: string;
  voteAverage?: number;
  voteCount?: number;
  trailerUrl?: string;
  genres: string[];
  genreIds?: number[];
  mediaInfo?: Media;
  availableQualities?: ('MP3' | 'FLAC')[];
}
export interface CuratedCollection {
  id: string;
  kind: 'tv' | 'music';
  name: string;
  overview: string;
  overviewSource?: { name: string; url: string };
  sourceUrl: string;
  posterPath?: string;
  backdropPath?: string;
  parts: CuratedCollectionMember[];
}
