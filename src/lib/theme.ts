/**
 * Theme management: 'light' / 'dark' / 'system'.
 * 'system' follows the OS preference and updates live if it changes.
 * Choice persisted in localStorage under STORAGE_KEY.
 */

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const STORAGE_KEY = 'homeguru-theme';

export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  } catch {
    // localStorage unavailable (private browsing, etc.) — fall through to default
  }
  return 'system';
}

export function setStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore — best effort
  }
}

export function getSystemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'system') return getSystemPrefersDark() ? 'dark' : 'light';
  return theme;
}

export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}
