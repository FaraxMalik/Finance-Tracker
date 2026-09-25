/** Colour palettes (light and dark), fonts and spacing. Read colours through useColors(), never import them directly. */

export type Palette = {
  bg: string;
  surface: string;
  surfaceHigh: string;
  border: string;
  text: string;
  textDim: string;
  /** Fill for primary actions (ink in light mode, paper in dark mode). */
  accent: string;
  /** Text/icon colour that sits on `accent`. */
  onAccent: string;
  /** Credit card */
  credit: string;
  /** Money in / owed to me / salary-funded spending */
  income: string;
  /** Money I owe / destructive */
  danger: string;
  warn: string;
  /** Built-in category colours */
  catCredit: string;
  catSalary: string;
  catOthers: string;
  /** Tones for categories the user adds */
  catExtra: readonly string[];
};

/** Warm paper background, ink text. */
export const lightPalette: Palette = {
  bg: '#F5F4F0',
  surface: '#FFFFFF',
  surfaceHigh: '#EEEBE5',
  border: '#E4E1DA',
  text: '#181712',
  textDim: '#7B776D',
  accent: '#181712',
  onAccent: '#F5F4F0',
  credit: '#3F4E73',
  income: '#3E6B57',
  danger: '#A8483F',
  warn: '#8F6F1F',
  catCredit: '#3F4E73',
  catSalary: '#3E6B57',
  catOthers: '#B07D5B',
  catExtra: ['#7A5C7E', '#5F7F8C', '#8C7A3F', '#6E7F5A', '#8A5A5A'],
};

/** Warm near-black, softened colours. */
export const darkPalette: Palette = {
  bg: '#0E0E0D',
  surface: '#171715',
  surfaceHigh: '#22211F',
  border: '#2B2A27',
  text: '#F1EFEA',
  textDim: '#98948A',
  accent: '#F1EFEA',
  onAccent: '#0E0E0D',
  credit: '#8FA2CF',
  income: '#7DB398',
  danger: '#D9847C',
  warn: '#D2B36B',
  catCredit: '#8FA2CF',
  catSalary: '#7DB398',
  catOthers: '#D19E7A',
  catExtra: ['#B48FB8', '#86AAB8', '#C2AE6A', '#9BB07C', '#C58F8F'],
};

/** One complete typeface: a file per weight, plus tuning for how it sits in the layout. */
export type FontSet = {
  label: string;
  regular: string;
  medium: string;
  semibold: string;
  bold: string;
  /** Big figures and titles */
  display: string;
  /** Multiplies font sizes (monospaced faces are wider, so they run a touch smaller). */
  scale: number;
  /** Letter spacing for titles and the big total (em-relative feel: negative tightens). */
  displaySpacing: number;
};

export type FontChoice = 'mono' | 'serif' | 'classic';

export const fontSets: Record<FontChoice, FontSet> = {
  /** Geist Mono: minimal, and digits line up in columns. */
  mono: {
    label: 'Mono',
    regular: 'GeistMono_400Regular',
    medium: 'GeistMono_500Medium',
    semibold: 'GeistMono_600SemiBold',
    bold: 'GeistMono_700Bold',
    display: 'GeistMono_500Medium',
    scale: 0.92,
    displaySpacing: -1.2,
  },
  /** Source Serif 4: a quiet, readable text serif. */
  serif: {
    label: 'Serif',
    regular: 'SourceSerif4_400Regular',
    medium: 'SourceSerif4_500Medium',
    semibold: 'SourceSerif4_600SemiBold',
    bold: 'SourceSerif4_700Bold',
    display: 'SourceSerif4_600SemiBold',
    scale: 1.04,
    displaySpacing: -0.6,
  },
  /** The first choice: Fraunces figures with Inter text. */
  classic: {
    label: 'Classic',
    regular: 'Inter_400Regular',
    medium: 'Inter_500Medium',
    semibold: 'Inter_600SemiBold',
    bold: 'Inter_700Bold',
    display: 'Fraunces_500Medium',
    scale: 1,
    displaySpacing: -0.8,
  },
};

export const DEFAULT_FONT: FontChoice = 'mono';

/** Custom fonts ship one file per weight, so map a CSS-style weight onto the right family. */
export function fontForWeight(weight: string | number | undefined, set: FontSet): string {
  switch (String(weight)) {
    case '500':
      return set.medium;
    case '600':
      return set.semibold;
    case '700':
    case 'bold':
    case '800':
    case '900':
      return set.bold;
    default:
      return set.regular;
  }
}

export const Spacing = {
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
} as const;

export const Radius = { sm: 10, md: 12, lg: 16, xl: 18, pill: 999 } as const;

/** Bottom padding on tab pages. */
export const TabBarClearance = 32;

/** '#RRGGBB' + 0..1 -> 'rgba(r,g,b,a)' */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
