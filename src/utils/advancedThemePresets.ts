import type {
  AdvancedThemeOverrides,
  AdvancedThemePresetId,
} from '@server/utils/advancedThemeOverrides';

export type AdvancedThemeMode = 'dark' | 'light';

export type AdvancedThemePreset = {
  id: AdvancedThemePresetId;
  name: string;
  description: string;
  swatches: string[];
  overrides: AdvancedThemeOverrides;
  chromeByMode: Record<AdvancedThemeMode, Partial<AdvancedThemeOverrides>>;
};

const johnPalette = {
  gray: { light: '#cccccc', normal: '#999999', dark: '#666666' },
  black: { light: '#4d4d4d', normal: '#333333', dark: '#1a1a1a' },
  red: { light: '#ff6666', normal: '#d52c2c', dark: '#8f1717' },
  orange: { light: '#fb923c', normal: '#f97316', dark: '#c2410c' },
  yellow: { light: '#ffe53d', normal: '#d8c000', dark: '#8c7900' },
  lime: { light: '#d4f75a', normal: '#aee000', dark: '#668500' },
  green: { light: '#68dc66', normal: '#3ab338', dark: '#227a27' },
  aqua: { light: '#64d5e7', normal: '#1aabcb', dark: '#065769' },
  blue: { light: '#4d8fff', normal: '#0051d4', dark: '#002b70' },
  purple: { light: '#a78bfa', normal: '#8b5cf6', dark: '#6d28d9' },
  plum: { light: '#b85ad3', normal: '#8414a6', dark: '#470b59' },
  pink: { light: '#ff5fc4', normal: '#e3008e', dark: '#8f005a' },
} as const;

const johnPaletteOverrides = Object.fromEntries(
  Object.entries(johnPalette).flatMap(([family, shades]) => [
    [`--palette-${family}-light`, shades.light],
    [`--palette-${family}`, shades.normal],
    [`--palette-${family}-dark`, shades.dark],
  ])
) as Pick<
  AdvancedThemeOverrides,
  | '--palette-gray-light'
  | '--palette-gray'
  | '--palette-gray-dark'
  | '--palette-black-light'
  | '--palette-black'
  | '--palette-black-dark'
  | '--palette-red-light'
  | '--palette-red'
  | '--palette-red-dark'
  | '--palette-orange-light'
  | '--palette-orange'
  | '--palette-orange-dark'
  | '--palette-yellow-light'
  | '--palette-yellow'
  | '--palette-yellow-dark'
  | '--palette-lime-light'
  | '--palette-lime'
  | '--palette-lime-dark'
  | '--palette-green-light'
  | '--palette-green'
  | '--palette-green-dark'
  | '--palette-aqua-light'
  | '--palette-aqua'
  | '--palette-aqua-dark'
  | '--palette-blue-light'
  | '--palette-blue'
  | '--palette-blue-dark'
  | '--palette-purple-light'
  | '--palette-purple'
  | '--palette-purple-dark'
  | '--palette-plum-light'
  | '--palette-plum'
  | '--palette-plum-dark'
  | '--palette-pink-light'
  | '--palette-pink'
  | '--palette-pink-dark'
>;

const johnBlueScale: Partial<AdvancedThemeOverrides> = {
  '--color-indigo-50': '#eff6ff',
  '--color-indigo-100': '#dbeafe',
  '--color-indigo-200': '#bfdbfe',
  '--color-indigo-300': '#93c5fd',
  '--color-indigo-400': '#60a5fa',
  '--color-indigo-500': '#3b82f6',
  '--color-indigo-600': '#2563eb',
  '--color-indigo-700': '#1d4ed8',
  '--color-indigo-800': '#1e40af',
  '--color-indigo-900': '#1e3a8a',
  '--color-indigo-950': '#172554',
};

const johnVisualSystem: AdvancedThemePreset = {
  id: 'john-redesign',
  name: "John's Visual System",
  description:
    'John’s earlier blue and silver visual system, with hue-coded shared controls and artwork badges. It preserves the current pages and workflows.',
  swatches: ['#0051d4', '#999999', '#8b5cf6', '#3ab338'],
  overrides: {
    preset: 'john-redesign',
    ...johnBlueScale,
    ...johnPaletteOverrides,
  },
  chromeByMode: {
    dark: {
      '--theme-page-bg': '#030712',
      '--theme-page-glow-start': '#0c1726',
      '--theme-page-glow-end': '#030712',
      '--theme-page-spotlight-center': '#4d8fff',
      '--theme-page-spotlight-edge': '#0051d4',
      '--theme-page-spotlight-strength': 0.55,
      '--theme-page-gradient-light': '#0e2a4f',
      '--theme-page-gradient-main': '#082349',
      '--theme-page-gradient-deep': '#031022',
      '--theme-page-gradient-black': '#000000',
      '--theme-page-gradient-main-stop': '60%',
      '--theme-searchbar-scrolled': '#183b67',
      '--theme-sidebar-start': '#0d2542',
      '--theme-sidebar-end': '#05101d',
      '--theme-sidebar-border': '#315579',
      '--theme-sidebar-hover': '#17375b',
      '--theme-control-surface': '#082b52',
      '--theme-control-surface-hover': '#0e3b70',
      '--theme-control-border': '#0051d4',
      '--theme-control-text': '#bfdbfe',
      '--theme-heading-text': '#f8fafc',
      '--theme-artwork-scrim': '#0b2c56',
      '--theme-artwork-gradient-light': '#2563a8',
      '--theme-artwork-gradient-main': '#0e3b70',
      '--theme-artwork-gradient-deep': '#031022',
      '--theme-artwork-gradient-black': '#000000',
      '--theme-artwork-text': '#dbeafe',
      '--theme-overlay-light': '#1e4a7a',
      '--theme-overlay-main': '#0e2e58',
      '--theme-overlay-deep': '#06172f',
      '--theme-overlay-neutral': '#071321',
      '--theme-overlay-menu': '#0a1928',
      '--theme-detail-divider-shadow': '0 0 4px 0 rgb(255 255 255 / 0.35)',
    },
    light: {
      '--theme-page-bg': '#f8fafc',
      '--theme-page-glow-start': '#eff6ff',
      '--theme-page-glow-end': '#f8fafc',
      '--theme-page-spotlight-center': '#bfdbfe',
      '--theme-page-spotlight-edge': '#60a5fa',
      '--theme-page-spotlight-strength': 0.45,
      '--theme-page-gradient-light': '#dbeafe',
      '--theme-page-gradient-main': '#bfdbfe',
      '--theme-page-gradient-deep': '#e2e8f0',
      '--theme-page-gradient-black': '#f8fafc',
      '--theme-page-gradient-main-stop': '55%',
      '--theme-searchbar-scrolled': '#dbeafe',
      '--theme-sidebar-start': '#eff6ff',
      '--theme-sidebar-end': '#dbeafe',
      '--theme-sidebar-border': '#93c5fd',
      '--theme-sidebar-hover': '#dbeafe',
      '--theme-control-surface': '#dbeafe',
      '--theme-control-surface-hover': '#bfdbfe',
      '--theme-control-border': '#2563eb',
      '--theme-control-text': '#1e3a8a',
      '--theme-heading-text': '#0f172a',
      '--theme-artwork-scrim': '#1e3a8a',
      '--theme-artwork-gradient-light': '#3b82f6',
      '--theme-artwork-gradient-main': '#1d4ed8',
      '--theme-artwork-gradient-deep': '#1e3a8a',
      '--theme-artwork-gradient-black': '#0f172a',
      '--theme-artwork-text': '#eff6ff',
      '--theme-overlay-light': '#dbeafe',
      '--theme-overlay-main': '#bfdbfe',
      '--theme-overlay-deep': '#93c5fd',
      '--theme-overlay-neutral': '#f1f5f9',
      '--theme-overlay-menu': '#ffffff',
      '--theme-detail-divider-shadow': '0 0 4px 0 rgb(15 23 42 / 0.25)',
    },
  },
};

export const advancedThemePresets: AdvancedThemePreset[] = [johnVisualSystem];

export const getAdvancedThemePreset = (id?: string) =>
  advancedThemePresets.find((preset) => preset.id === id);
