import { useState, useEffect, useCallback } from 'react';
import {
  type Theme,
  type ResolvedTheme,
  getStoredTheme,
  setStoredTheme,
  applyTheme,
  resolveTheme,
} from '@/lib/theme';

interface UseThemeReturn {
  theme: Theme;
  resolved: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

export function useTheme(): UseThemeReturn {
  const [theme, setThemeState] = useState<Theme>(() => getStoredTheme());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(theme));

  const setTheme = useCallback((next: Theme) => {
    setStoredTheme(next);
    applyTheme(next);
    setThemeState(next);
    setResolved(resolveTheme(next));
  }, []);

  // When theme === 'system', react live to OS preference changes
  useEffect(() => {
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      applyTheme('system');
      setResolved(resolveTheme('system'));
    };
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [theme]);

  return { theme, resolved, setTheme };
}
