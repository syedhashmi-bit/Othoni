import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from 'react';

// ---------- Global in-flight tracker ----------
// Every active usePoller invocation bumps this counter while its fetch
// is pending. The top progress bar subscribes via useInFlightCount().
// Module-scoped so it survives unrelated component remounts.
let inFlight = 0;
const inFlightSubs = new Set();
function notifyInFlight() {
  for (const fn of inFlightSubs) fn();
}
function subscribeInFlight(fn) {
  inFlightSubs.add(fn);
  return () => inFlightSubs.delete(fn);
}
function getInFlight() {
  return inFlight;
}
export function useInFlightCount() {
  return useSyncExternalStore(subscribeInFlight, getInFlight, getInFlight);
}

// Polls `loader` every `intervalMs`. Returns { data, error, loading, refresh }.
// Pause when document is hidden so we don't spam the server.
export function usePoller(loader, intervalMs = 5000, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const stopped = useRef(false);
  const timer = useRef(null);

  const tick = useCallback(async () => {
    inFlight++; notifyInFlight();
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
      inFlight = Math.max(0, inFlight - 1); notifyInFlight();
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

// ---------- useCountUp ----------
// Smoothly tween between numeric values when `value` changes.
// `format` is a function `(n) => string` so callers can keep their
// existing display formatting (percent, bytes, etc.) intact.
// On mount, returns the value immediately (no tween from zero).
export function useCountUp(value, { durationMs = 320, format = (n) => String(n) } = {}) {
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  const startRef = useRef(0);
  const rafRef = useRef(0);

  useEffect(() => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      setShown(value);
      return undefined;
    }
    // First mount or a non-numeric previous: snap.
    if (typeof fromRef.current !== 'number' || !Number.isFinite(fromRef.current)) {
      fromRef.current = value;
      setShown(value);
      return undefined;
    }
    if (fromRef.current === value) return undefined;
    const from = fromRef.current;
    const to = value;
    startRef.current = performance.now();
    cancelAnimationFrame(rafRef.current);
    const step = (t) => {
      const p = Math.min(1, (t - startRef.current) / durationMs);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - p, 3);
      const next = from + (to - from) * eased;
      setShown(next);
      if (p < 1) rafRef.current = requestAnimationFrame(step);
      else fromRef.current = to;
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, durationMs]);

  return typeof shown === 'number' ? format(shown) : shown;
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
