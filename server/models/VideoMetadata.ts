export type VideoMetadataSourceName = 'tmdb' | 'tvdb' | 'tvmaze' | 'wikidata';

export interface VideoMetadataAttribution {
  source: VideoMetadataSourceName;
  url: string;
  license?: string;
  licenseUrl?: string;
  fetchedAt: string;
  stale: boolean;
}

export interface VideoMetadataSupplemental {
  posterUrl?: string;
  genres: string[];
  studios: string[];
  networks: string[];
  directors: string[];
  writers: string[];
}

export interface VideoMetadataProvenance {
  sources: VideoMetadataAttribution[];
  fields: Record<string, VideoMetadataSourceName[]>;
  lastUpdatedAt?: string;
  expiresAt: string;
  supplemental: VideoMetadataSupplemental;
}
