import { useEffect, useRef, useState, useCallback } from 'react';

// Polls `loader` every `intervalMs`. Returns { data, error, loading, refresh }.
// Pause when document is hidden so we don't spam the server.
export function usePoller(loader, intervalMs = 5000, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const stopped = useRef(false);
  const timer = useRef(null);

  const tick = useCallback(async () => {
    try {
      const d = await loader();
      if (!stopped.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (!stopped.current) setError(e);
    } finally {
      if (!stopped.current) setLoading(false);
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    stopped.current = false;
    tick();
    const schedule = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        if (!document.hidden) await tick();
        if (!stopped.current) schedule();
      }, intervalMs);
    };
    schedule();
    const onVis = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped.current = true;
      clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [intervalMs, tick]);

  return { data, error, loading, refresh: tick };
}

// Local-storage-backed setting.
export function useLocalSetting(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? defaultValue : JSON.parse(raw);
    } catch {
      return defaultValue;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }, [key, value]);
  return [value, setValue];
}
