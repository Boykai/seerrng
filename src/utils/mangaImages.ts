const ANILIST_IMAGE_HOST = 's4.anilist.co';

// AniList covers and banners load through the existing same-origin image
// proxy. Anything other than a plain https URL on the AniList image host is
// dropped rather than loaded directly.
export const getMangaImageUrl = (imageUrl?: string): string | undefined => {
  if (!imageUrl) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    return undefined;
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== ANILIST_IMAGE_HOST ||
    url.username ||
    url.password ||
    url.port
  ) {
    return undefined;
  }

  return `/imageproxy/anilist${url.pathname}${url.search}`;
};
