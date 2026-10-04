import CachedImage from '@app/components/Common/CachedImage';
import Placeholder from '@app/components/TitleCard/Placeholder';
import defineMessages from '@app/utils/defineMessages';
import { getTmdbPosterImageUrl } from '@app/utils/imageCache';
import { ArrowRightCircleIcon } from '@heroicons/react/24/solid';
import Link from 'next/link';
import { memo, useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MediaSlider.ShowMoreCard', {
  seemore: 'See More',
});

interface ShowMoreCardProps {
  url: string;
  posters: (string | undefined)[];
}

const getImageProps = (poster: string) => {
  if (poster.startsWith('https://coverartarchive.org/')) {
    return { type: 'music' as const, src: poster };
  }

  if (poster.startsWith('https://covers.openlibrary.org/')) {
    return { type: 'book' as const, src: poster };
  }

  return {
    type: 'tmdb' as const,
    src: getTmdbPosterImageUrl(poster),
  };
};

const ShowMoreCard = memo(({ url, posters }: ShowMoreCardProps) => {
  const intl = useIntl();
  const [isHovered, setHovered] = useState(false);
  const { ref, inView } = useInView({
    triggerOnce: true,
  });
  const imageProps = useMemo(
    () => posters.map((poster) => (poster ? getImageProps(poster) : undefined)),
    [posters]
  );

  if (!inView) {
    return (
      <div ref={ref}>
        <Placeholder />
      </div>
    );
  }

  return (
    <Link
      href={url}
      prefetch={false}
      className="poster-layout"
      data-media-type="collection"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      role="link"
      tabIndex={0}
    >
      <div
        data-poster-region="frame"
        className={`app-card-poster app-card-poster-interactive ${isHovered ? 'app-card-poster-active' : ''}`}
      >
        <div data-poster-region="content">
          <div data-poster-region="mosaic">
            {imageProps[0] && (
              <div>
                <CachedImage
                  type={imageProps[0].type}
                  src={imageProps[0].src}
                  alt=""
                  width={300}
                  height={450}
                />
              </div>
            )}
            {imageProps[1] && (
              <div>
                <CachedImage
                  type={imageProps[1].type}
                  src={imageProps[1].src}
                  alt=""
                  width={300}
                  height={450}
                />
              </div>
            )}
            {imageProps[2] && (
              <div>
                <CachedImage
                  type={imageProps[2].type}
                  src={imageProps[2].src}
                  alt=""
                  width={300}
                  height={450}
                />
              </div>
            )}
            {imageProps[3] && (
              <div>
                <CachedImage
                  type={imageProps[3].type}
                  src={imageProps[3].src}
                  alt=""
                  width={300}
                  height={450}
                />
              </div>
            )}
          </div>
          <div data-poster-region="collection-action">
            <ArrowRightCircleIcon />
            <div className="card-title" data-title-weight="regular">
              {intl.formatMessage(messages.seemore)}
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
});

ShowMoreCard.displayName = 'ShowMoreCard';

export default ShowMoreCard;
