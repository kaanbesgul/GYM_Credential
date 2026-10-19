import { useCallback, useEffect, useRef, useState } from 'react';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Veriyi yükler; `refreshMs` verilirse arka planda tazeler (yenilemede ekran titremez). */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[], refreshMs?: number): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const run = useCallback((silent: boolean) => {
    if (!silent) setLoading(true);
    return loaderRef
      .current()
      .then((value) => {
        setData(value);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Yüklenemedi.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setData(null);
    void run(false);
    if (!refreshMs) return;
    const timer = setInterval(() => void run(true), refreshMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, refreshMs]);

  return { data, error, loading, reload: () => void run(true) };
}

/** Adres çubuğundaki #/sayfa kısmını izler. */
export function useHash(fallback: string): [string, (page: string) => void] {
  const read = () => window.location.hash.replace(/^#\/?/, '') || fallback;
  const [hash, setHash] = useState(read);
  useEffect(() => {
    const onChange = () => setHash(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [hash, (page) => (window.location.hash = `/${page}`)];
}
