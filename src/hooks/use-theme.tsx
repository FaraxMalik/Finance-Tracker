import { useSQLiteContext } from 'expo-sqlite';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import {
  darkPalette,
  DEFAULT_FONT,
  fontSets,
  lightPalette,
  type FontChoice,
  type FontSet,
  type Palette,
} from '@/constants/theme';

export type ThemeMode = 'system' | 'light' | 'dark';

type ThemeValue = {
  /** What the user chose. */
  mode: ThemeMode;
  /** What is actually showing right now. */
  scheme: 'light' | 'dark';
  colors: Palette;
  setMode: (mode: ThemeMode) => void;
  /** The chosen typeface and its font files. */
  font: FontChoice;
  fonts: FontSet;
  setFont: (font: FontChoice) => void;
};

const ThemeContext = createContext<ThemeValue | null>(null);

const KEY = 'theme_mode';
const FONT_KEY = 'font_choice';

const isFont = (v: unknown): v is FontChoice => v === 'mono' || v === 'serif' || v === 'classic';

const SAVE_SQL =
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';

/**
 * Must sit inside SQLiteProvider: the choice is remembered in the settings table.
 * Renders nothing until the saved choice is read, so the first frame is never the wrong theme
 * (the splash screen stays up meanwhile).
 */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const system = useColorScheme();
  const [saved, setSaved] = useState<ThemeMode | null>(null);
  const [font, setFontState] = useState<FontChoice>(DEFAULT_FONT);

  useEffect(() => {
    let alive = true;
    const read = (key: string) => db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
    Promise.all([read(KEY), read(FONT_KEY)])
      .then(([theme, face]) => {
        if (!alive) return;
        if (isFont(face?.value)) setFontState(face.value);
        setSaved(theme?.value === 'light' || theme?.value === 'dark' ? theme.value : 'system');
      })
      .catch(() => alive && setSaved('system'));
    return () => {
      alive = false;
    };
  }, [db]);

  const setMode = useCallback(
    (next: ThemeMode) => {
      setSaved(next);
      db.runAsync(SAVE_SQL, KEY, next).catch(() => {});
    },
    [db],
  );

  const setFont = useCallback(
    (next: FontChoice) => {
      setFontState(next);
      db.runAsync(SAVE_SQL, FONT_KEY, next).catch(() => {});
    },
    [db],
  );

  const mode: ThemeMode = saved ?? 'system';
  const scheme: 'light' | 'dark' = mode === 'system' ? (system === 'dark' ? 'dark' : 'light') : mode;
  const value = useMemo<ThemeValue>(
    () => ({
      mode,
      scheme,
      colors: scheme === 'dark' ? darkPalette : lightPalette,
      setMode,
      font,
      fonts: fontSets[font],
      setFont,
    }),
    [mode, scheme, setMode, font, setFont],
  );

  if (saved === null) return null;
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside AppThemeProvider');
  return value;
}

export function useColors(): Palette {
  return useTheme().colors;
}

/**
 * Builds a StyleSheet from the current palette. Pass a module-level function so it stays stable:
 *   const makeStyles = (c: Palette) => StyleSheet.create({ ... });
 *   const styles = useStyles(makeStyles);
 */
export function useStyles<T>(make: (c: Palette) => T): T {
  const colors = useColors();
  return useMemo(() => make(colors), [colors, make]);
}
