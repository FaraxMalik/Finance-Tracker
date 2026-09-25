import { useFocusEffect } from 'expo-router';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Runs `loader` every time the screen gains focus, so data is fresh after
 * adding/editing on another screen. Returns null until the first load finishes.
 */
export function useFocusLoad<T>(loader: (db: SQLiteDatabase) => Promise<T>) {
  const db = useSQLiteContext();
  const loaderRef = useRef(loader);
  const [data, setData] = useState<T | null>(null);

  // Declared before useFocusEffect so the latest loader is in place when a focus load runs.
  useEffect(() => {
    loaderRef.current = loader;
  });

  const reload = useCallback(async () => {
    setData(await loaderRef.current(db));
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      loaderRef.current(db).then((d) => alive && setData(d));
      return () => {
        alive = false;
      };
    }, [db]),
  );

  return { data, reload };
}
