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

// Triggers a one-shot CSS class for `durationMs` whenever `value` changes.
// The first render does NOT trigger (so cards don't all flash on mount);
// subsequent value changes briefly add `className` to whatever element
// renders the returned `flash` prop. Use with the .value-flash CSS class.
export function useFlashOnChange(value, durationMs = 600) {
  const [flashing, setFlashing] = useState(false);
  const prevRef = useRef(value);
  const tidRef = useRef(null);
  useEffect(() => {
    // Skip the first run — initial mount shouldn't flash everything.
    if (prevRef.current === value) return;
    prevRef.current = value;
    setFlashing(true);
    clearTimeout(tidRef.current);
    tidRef.current = setTimeout(() => setFlashing(false), durationMs);
    return () => clearTimeout(tidRef.current);
  }, [value, durationMs]);
  return flashing;
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
