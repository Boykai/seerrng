import CachedImage from '@app/components/Common/CachedImage';
import type { ForwardRefRenderFunction, HTMLAttributes } from 'react';
import React, { useEffect, useMemo, useState } from 'react';

interface ImageFaderProps extends HTMLAttributes<HTMLDivElement> {
  backgroundImages: string[];
  backgroundTitles?: string[];
  rotationSpeed?: number;
  isDarker?: boolean;
  forceOptimize?: boolean;
}

const DEFAULT_ROTATION_SPEED = 6000;

const ImageFader: ForwardRefRenderFunction<HTMLDivElement, ImageFaderProps> = (
  {
    backgroundImages,
    backgroundTitles,
    rotationSpeed = DEFAULT_ROTATION_SPEED,
    isDarker,
    forceOptimize,
    ...props
  },
  ref
) => {
  const [activeIndex, setIndex] = useState(0);
  const imageCount = backgroundImages.length;
  const visibleImageIndexes = useMemo(() => {
    if (imageCount === 0) {
      return [];
    }

    if (imageCount === 1) {
      return [0];
    }

    return [activeIndex, (activeIndex + 1) % imageCount];
  }, [activeIndex, imageCount]);
  const imageStyle = useMemo(
    () => ({ width: '100%', height: '100%', objectFit: 'cover' as const }),
    []
  );
  const imageOverrides = useMemo(
    () => (forceOptimize ? { unoptimized: false } : {}),
    [forceOptimize]
  );

  useEffect(() => {
    if (activeIndex >= imageCount) {
      setIndex(0);
    }
  }, [activeIndex, imageCount]);

  useEffect(() => {
    if (imageCount < 2) {
      return;
    }

    const interval = setInterval(
      () => setIndex((ai) => (ai + 1) % imageCount),
      rotationSpeed
    );

    return () => {
      clearInterval(interval);
    };
  }, [imageCount, rotationSpeed]);

  return (
    <div ref={ref}>
      {visibleImageIndexes.map((i) => {
        const imageUrl = backgroundImages[i];

        return (
          <div
            key={`banner-image-${i}`}
            className={`absolute-top-shift absolute inset-0 bg-cover bg-center transition-opacity duration-300 ease-in ${
              i === activeIndex ? 'opacity-100' : 'opacity-0'
            }`}
            {...props}
          >
            <CachedImage
              type="tmdb"
              className="absolute inset-0 h-full w-full"
              alt=""
              src={imageUrl}
              style={imageStyle}
              fill
              priority={i === activeIndex}
              loading={i === activeIndex ? 'eager' : 'lazy'}
              {...imageOverrides}
            />
            <div
              className={`absolute inset-0 ${isDarker ? 'bg-gray-900/55' : 'bg-gray-800/45'}`}
            />
            {backgroundTitles?.[i] && (
              <h1
                className="auth-backdrop-title text-overseerr text-2xl leading-6 font-bold"
                aria-hidden={i !== activeIndex}
              >
                {backgroundTitles[i]}
              </h1>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default React.forwardRef<HTMLDivElement, ImageFaderProps>(ImageFader);
