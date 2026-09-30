const shades = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

const themeColorTokens = [
  '--theme-page-bg',
  '--theme-page-glow-start',
  '--theme-page-glow-end',
  '--theme-page-spotlight-center',
  '--theme-page-spotlight-edge',
  '--theme-page-gradient-light',
  '--theme-page-gradient-main',
  '--theme-page-gradient-deep',
  '--theme-page-gradient-black',
  '--theme-searchbar-scrolled',
  '--theme-sidebar-start',
  '--theme-sidebar-end',
  '--theme-sidebar-border',
  '--theme-sidebar-hover',
  '--theme-control-surface',
  '--theme-control-surface-hover',
  '--theme-control-border',
  '--theme-control-text',
  '--theme-heading-text',
  '--theme-artwork-scrim',
  '--theme-artwork-gradient-light',
  '--theme-artwork-gradient-main',
  '--theme-artwork-gradient-deep',
  '--theme-artwork-gradient-black',
  '--theme-artwork-text',
  '--theme-overlay-light',
  '--theme-overlay-main',
  '--theme-overlay-deep',
  '--theme-overlay-neutral',
  '--theme-overlay-menu',
] as const;

export const ADVANCED_THEME_COLOR_TOKENS = [
  ...themeColorTokens,
  ...(['gray', 'indigo', 'purple'] as const).flatMap((palette) =>
    shades.map((shade) => `--color-${palette}-${shade}` as const)
  ),
] as const;

const advancedThemeColorTokenSet = new Set<string>(ADVANCED_THEME_COLOR_TOKENS);
const advancedThemeSpecialTokens = new Set([
  '--theme-page-spotlight-strength',
  '--theme-page-gradient-main-stop',
  '--theme-detail-divider-shadow',
]);
const allowedShadowValues = new Set([
  'none',
  '0 0 4px 0 rgb(255 255 255 / 0.8)',
  '0 0 4px 0 rgb(0 0 0 / 0.45)',
  '0 0 8px 0 rgb(255 255 255 / 0.35)',
  '0 0 8px 0 rgb(0 0 0 / 0.65)',
]);

export type AdvancedThemeOverrides = Partial<
  Record<(typeof ADVANCED_THEME_COLOR_TOKENS)[number], string>
> & {
  '--theme-page-spotlight-strength'?: number;
  '--theme-page-gradient-main-stop'?: string;
  '--theme-detail-divider-shadow'?: string;
};

export type AdvancedThemeOverridesValidation =
  { value: AdvancedThemeOverrides | null } | { error: string };

const normalizeHexColor = (value: string): string | undefined => {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value);
  if (!match) return undefined;
  const hex =
    match[1].length === 3
      ? [...match[1]].map((part) => `${part}${part}`).join('')
      : match[1];
  return `#${hex.toLowerCase()}`;
};

export const getAdvancedThemeCssValue = (
  token: string,
  value: string | number
): string => {
  if (!advancedThemeColorTokenSet.has(token) || typeof value !== 'string') {
    return String(value);
  }

  const hex =
    value.length === 4
      ? [...value.slice(1)].map((part) => `${part}${part}`).join('')
      : value.slice(1);
  return [0, 2, 4]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
    .join(' ');
};

export const validateAdvancedThemeOverrides = (
  input: unknown
): AdvancedThemeOverridesValidation => {
  if (input === null) return { value: null };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Theme overrides must be an object or null.' };
  }

  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > ADVANCED_THEME_COLOR_TOKENS.length + 3) {
    return { error: 'Theme overrides contain too many values.' };
  }

  const normalized: Record<string, string | number> = {};
  for (const [token, rawValue] of entries) {
    if (advancedThemeColorTokenSet.has(token)) {
      if (typeof rawValue !== 'string') {
        return { error: `${token} must be a hexadecimal color.` };
      }
      const color = normalizeHexColor(rawValue);
      if (!color) {
        return { error: `${token} must use #RGB or #RRGGBB format.` };
      }
      normalized[token] = color;
      continue;
    }

    if (!advancedThemeSpecialTokens.has(token)) {
      return { error: `${token} is not a supported theme token.` };
    }

    if (token === '--theme-page-spotlight-strength') {
      if (
        typeof rawValue !== 'number' ||
        !Number.isFinite(rawValue) ||
        rawValue < 0 ||
        rawValue > 1
      ) {
        return {
          error: `${token} must be a number from 0 through 1.`,
        };
      }
      normalized[token] = rawValue;
      continue;
    }

    if (token === '--theme-page-gradient-main-stop') {
      if (
        typeof rawValue !== 'string' ||
        !/^(?:100|[1-9]?\d)%$/.test(rawValue)
      ) {
        return { error: `${token} must be a percentage from 0% through 100%.` };
      }
      normalized[token] = rawValue;
      continue;
    }

    if (typeof rawValue !== 'string' || !allowedShadowValues.has(rawValue)) {
      return { error: `${token} must use one of the supported shadow values.` };
    }
    normalized[token] = rawValue;
  }

  return {
    value: Object.keys(normalized).length
      ? (normalized as AdvancedThemeOverrides)
      : null,
  };
};
