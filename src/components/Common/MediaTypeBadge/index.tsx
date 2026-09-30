import Tooltip from '@app/components/Common/Tooltip';
import globalMessages from '@app/i18n/globalMessages';
import {
  BookOpenIcon,
  FilmIcon,
  MusicalNoteIcon,
  NewspaperIcon,
  RectangleStackIcon,
  Square3Stack3DIcon,
  TvIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';
import { twMerge } from 'tailwind-merge';

export type MediaTypeBadgeType =
  | 'movie'
  | 'tv'
  | 'collection'
  | 'album'
  | 'artist'
  | 'book'
  | 'comic'
  | 'magazine';

export const mediaTypeBadgeTone: Record<MediaTypeBadgeType, string> = {
  movie: 'border-blue-500/70 bg-blue-700/35 text-blue-50',
  tv: 'border-violet-300/90 bg-purple-700/35 text-purple-50',
  collection: 'border-blue-500/70 bg-blue-700/35 text-blue-50',
  album: 'border-emerald-500/70 bg-emerald-700/35 text-emerald-50',
  artist: 'border-fuchsia-500/70 bg-fuchsia-700/35 text-fuchsia-50',
  book: 'border-amber-500/70 bg-amber-700/35 text-amber-50',
  comic: 'border-rose-500/70 bg-rose-700/35 text-rose-50',
  magazine: 'border-cyan-400/70 bg-cyan-700/35 text-cyan-50',
};

export const getMediaTypeBadgeType = (
  mediaType: string
): MediaTypeBadgeType | undefined => {
  if (mediaType === 'music') {
    return 'album';
  }

  if (
    mediaType === 'movie' ||
    mediaType === 'tv' ||
    mediaType === 'collection' ||
    mediaType === 'album' ||
    mediaType === 'artist' ||
    mediaType === 'book' ||
    mediaType === 'comic' ||
    mediaType === 'magazine'
  ) {
    return mediaType;
  }

  return undefined;
};

interface MediaTypeBadgeProps {
  mediaType: MediaTypeBadgeType;
  variant?: 'card' | 'compact' | 'inline' | 'button';
  className?: string;
  showIcon?: boolean;
  /**
   * Overrides the default per-type label (e.g. 'Album') while keeping that
   * type's icon and tone -- for contexts where the same icon/color applies
   * but the content-type label doesn't fit (a Plex library row is a whole
   * Music library, not a single Album).
   */
  label?: string;
}

const badgeConfig = {
  movie: {
    message: globalMessages.movie,
    icon: FilmIcon,
    tone: mediaTypeBadgeTone.movie,
  },
  tv: {
    message: globalMessages.tvshow,
    icon: TvIcon,
    tone: mediaTypeBadgeTone.tv,
  },
  collection: {
    message: globalMessages.collection,
    icon: RectangleStackIcon,
    tone: mediaTypeBadgeTone.collection,
  },
  album: {
    message: globalMessages.album,
    icon: MusicalNoteIcon,
    tone: mediaTypeBadgeTone.album,
  },
  artist: {
    message: globalMessages.artist,
    icon: UserCircleIcon,
    tone: mediaTypeBadgeTone.artist,
  },
  book: {
    message: globalMessages.book,
    icon: BookOpenIcon,
    tone: mediaTypeBadgeTone.book,
  },
  comic: {
    message: globalMessages.comic,
    icon: Square3Stack3DIcon,
    tone: mediaTypeBadgeTone.comic,
  },
  magazine: {
    message: globalMessages.magazine,
    icon: NewspaperIcon,
    tone: mediaTypeBadgeTone.magazine,
  },
} as const satisfies Record<
  MediaTypeBadgeType,
  {
    message: (typeof globalMessages)[keyof typeof globalMessages];
    icon: typeof FilmIcon;
    tone: string;
  }
>;

const variantClasses = {
  card: 'poster-control shadow-md',
  compact: 'px-2 py-1 text-[11px]',
  inline: 'px-2 py-1 text-xs',
  button: 'app-button button-sm',
} as const;

const posterToneClass: Record<MediaTypeBadgeType, string> = {
  movie: 'poster-control-type-movie',
  tv: 'poster-control-type-tv',
  collection: 'poster-control-type-collection',
  album: 'poster-control-type-album',
  artist: 'poster-control-type-artist',
  book: 'poster-control-type-book',
  comic: 'poster-control-type-comic',
  magazine: 'poster-control-type-magazine',
};

const buttonToneClass: Record<MediaTypeBadgeType, string> = {
  movie: 'app-button-media-type-movie',
  tv: 'app-button-media-type-tv',
  collection: 'app-button-media-type-collection',
  album: 'app-button-media-type-album',
  artist: 'app-button-media-type-artist',
  book: 'app-button-media-type-book',
  comic: 'app-button-media-type-comic',
  magazine: 'app-button-media-type-magazine',
};

const MediaTypeBadge = ({
  mediaType,
  variant = 'compact',
  className,
  showIcon = true,
  label: labelOverride,
}: MediaTypeBadgeProps) => {
  const intl = useIntl();
  const config = badgeConfig[mediaType];
  const label = labelOverride ?? intl.formatMessage(config.message);
  const Icon = config.icon;

  const badge = (
    <span
      className={twMerge(
        variant === 'card' || variant === 'button'
          ? 'max-w-full'
          : 'inline-flex max-w-full items-center gap-1 rounded-full border leading-none font-semibold',
        variantClasses[variant],
        variant === 'card'
          ? posterToneClass[mediaType]
          : variant === 'button'
            ? buttonToneClass[mediaType]
            : config.tone,
        className
      )}
    >
      {showIcon && (
        <Icon
          className="h-3.5 w-3.5 shrink-0 -translate-y-px"
          aria-hidden="true"
        />
      )}
      <span className="truncate">{label}</span>
    </span>
  );

  return <Tooltip content={label}>{badge}</Tooltip>;
};

export default MediaTypeBadge;
