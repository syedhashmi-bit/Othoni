// Theme preference: 'dark' | 'light' | 'system'. Stored as JSON under
// `othoni.theme` (same encoding as useLocalSetting) and resolved onto
// <html data-theme>. index.html runs the same resolution inline before the
// bundle loads so a light-mode user never sees a dark flash.

export const THEME_KEY = 'othoni.theme';
export const THEME_OPTIONS = ['system', 'dark', 'light'];

const META_COLORS = { dark: '#0b0f17', light: '#f5f7fb' };

const mql = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null;

export function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return mql && mql.matches ? 'light' : 'dark';
}

export function applyTheme(pref) {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', META_COLORS[resolved]);
  return resolved;
}

// Re-apply when the OS scheme flips while the preference is 'system'.
export function watchSystemTheme(pref) {
  if (!mql || pref !== 'system') return () => {};
  const onChange = () => applyTheme('system');
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

export function nextTheme(pref) {
  const i = THEME_OPTIONS.indexOf(pref);
  return THEME_OPTIONS[(i + 1) % THEME_OPTIONS.length];
}
