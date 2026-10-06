/**
 * A reader service address as SeerrNG saves it: without trailing slashes, and
 * with a pasted OPDS or Komga API address reduced to the service address.
 */
export const normalizeReaderServiceUrl = (value: string): string =>
  value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:api\/v1\/opds|komga\/api)$/i, '');

/**
 * The form in which two saved reader service addresses are compared: the
 * scheme and host ignore case, a default port is dropped and trailing slashes
 * are ignored.
 */
export const getComparableReaderServiceUrl = (value: string): string => {
  try {
    const url = new URL(value);
    return url.protocol + '//' + url.host + url.pathname.replace(/\/+$/, '');
  } catch {
    return value;
  }
};
