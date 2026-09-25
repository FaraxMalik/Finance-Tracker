import { Fraunces_500Medium } from '@expo-google-fonts/fraunces';
import {
  GeistMono_400Regular,
  GeistMono_500Medium,
  GeistMono_600SemiBold,
  GeistMono_700Bold,
} from '@expo-google-fonts/geist-mono';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import {
  SourceSerif4_400Regular,
  SourceSerif4_500Medium,
  SourceSerif4_600SemiBold,
  SourceSerif4_700Bold,
} from '@expo-google-fonts/source-serif-4';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo } from 'react';
import { Platform } from 'react-native';

import { DB_NAME, migrate, SCHEMA_VERSION } from '@/db/schema';
import { AppThemeProvider, useTheme } from '@/hooks/use-theme';

SplashScreen.preventAutoHideAsync();

/** Browser-preview helper only: lets a script load demo data. Compiled out of real builds. */
function DevTools() {
  const db = useSQLiteContext();
  useEffect(() => {
    if (__DEV__ && Platform.OS === 'web') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (globalThis as Record<string, unknown>).__seed = () => require('@/dev/seed').seedDemo(db);
      // Lets a test script poke the database (e.g. to simulate an older schema version).
      (globalThis as Record<string, unknown>).__exec = (sql: string) => db.execAsync(sql);
    }
  }, [db]);
  return null;
}

/** Everything that depends on the light/dark choice. */
function ThemedApp() {
  const { colors, scheme } = useTheme();

  // The theme is loaded by now, so the first real frame is already the right colours.
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  const navTheme = useMemo(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        background: colors.bg,
        card: colors.surface,
        border: colors.border,
        primary: colors.accent,
        text: colors.text,
      },
    };
  }, [scheme, colors]);

  return (
    <NavThemeProvider value={navTheme}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <DevTools />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: 'slide_from_right',
        }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="add" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="debt-entry" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="quick" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="quick-edit" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
      </Stack>
    </NavThemeProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Fraunces_500Medium,
    GeistMono_400Regular,
    GeistMono_500Medium,
    GeistMono_600SemiBold,
    GeistMono_700Bold,
    SourceSerif4_400Regular,
    SourceSerif4_500Medium,
    SourceSerif4_600SemiBold,
    SourceSerif4_700Bold,
  });

  // Safety net: never leave the splash up forever if the database can't open.
  useEffect(() => {
    const t = setTimeout(() => SplashScreen.hideAsync(), 10000);
    return () => clearTimeout(t);
  }, []);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SQLiteProvider key={SCHEMA_VERSION} databaseName={DB_NAME} onInit={migrate}>
      <AppThemeProvider>
        <ThemedApp />
      </AppThemeProvider>
    </SQLiteProvider>
  );
}
