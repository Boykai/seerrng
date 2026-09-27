// MusicBrainz release-group types are universal, not artist-specific.
// https://musicbrainz.org/doc/Release_Group/Type
export const MUSIC_PRIMARY_TYPES = [
  'Album',
  'Single',
  'EP',
  'Broadcast',
  'Other',
] as const;
export const MUSIC_SECONDARY_TYPES = [
  'Compilation',
  'Soundtrack',
  'Spokenword',
  'Interview',
  'Audiobook',
  'Audio drama',
  'Live',
  'Remix',
  'DJ-mix',
  'Mixtape/Street',
  'Demo',
  'Field recording',
] as const;
export const MUSIC_RELEASE_TYPES = [
  ...MUSIC_PRIMARY_TYPES,
  ...MUSIC_SECONDARY_TYPES,
];
export type MusicPrimaryType = (typeof MUSIC_PRIMARY_TYPES)[number];
export const formatMusicReleaseType = (
  primary: string,
  secondary: readonly string[] = []
) =>
  (primary.toLowerCase() === 'album' && secondary.length
    ? secondary
    : [primary, ...secondary]
  )
    .filter(Boolean)
    .join(' · ');
export const musicReleaseTypeField = (value: string) =>
  MUSIC_SECONDARY_TYPES.some(
    (type) => type.toLowerCase() === value.toLowerCase()
  )
    ? 'secondarytype'
    : 'primarytype';
export const matchesMusicReleaseType = (
  primary: string | undefined,
  secondary: readonly string[] | undefined,
  value: string
) =>
  !value ||
  (musicReleaseTypeField(value) === 'secondarytype'
    ? (secondary ?? [])
    : [primary ?? '']
  ).some((type) => type.toLowerCase() === value.toLowerCase());
