import { useState, useEffect } from 'react';
import type { Language } from './i18n';

export type Preferences = { language: Language; theme: 'auto' | 'light' | 'dark'; motion: boolean; economy: 'auto' | 'on' | 'off'; lock: number; view: 'list' | 'grid' };
const defaults: Preferences = { language: 'pt', theme: 'auto', motion: true, economy: 'auto', lock: 10, view: 'list' };
const query = (value: string) => matchMedia(value);

export function usePreferences() {
  const [prefs, setPrefs] = useState<Preferences>(() => {
    try {
      const p = JSON.parse(localStorage.getItem('cv-preferences') ?? '{}');
      return {
        language: p.language === 'en' || p.language === 'pt' ? p.language : defaults.language,
        theme: ['auto', 'light', 'dark'].includes(p.theme) ? p.theme : defaults.theme,
        motion: typeof p.motion === 'boolean' ? p.motion : defaults.motion,
        economy: ['auto', 'on', 'off'].includes(p.economy) ? p.economy : defaults.economy,
        lock: [1, 5, 10, 30].includes(p.lock) ? p.lock : defaults.lock,
        view: p.view === 'grid' ? 'grid' : defaults.view
      };
    } catch { return defaults; }
  });
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const dark = query('(prefers-color-scheme: dark)');
    const slow = query('(prefers-reduced-motion: reduce)');
    const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
    const apply = () => {
      document.documentElement.dataset.theme = (prefs.theme === 'dark' || prefs.theme === 'auto' && dark.matches) ? 'dark' : 'light';
      const weak = prefs.economy === 'auto' && ((nav.deviceMemory ?? 8) <= 4 || (nav.hardwareConcurrency || 8) <= 4 || nav.connection?.saveData);
      const noEffects = !prefs.motion || slow.matches || prefs.economy === 'on' || !!weak;
      document.documentElement.dataset.effects = noEffects ? 'off' : 'on';
      document.documentElement.lang = prefs.language === 'pt' ? 'pt-BR' : 'en';
      setReduced(noEffects);
    };
    apply();
    dark.addEventListener('change', apply);
    slow.addEventListener('change', apply);
    try { localStorage.setItem('cv-preferences', JSON.stringify(prefs)); } catch { /* Preferences are optional. */ }
    return () => { dark.removeEventListener('change', apply); slow.removeEventListener('change', apply); };
  }, [prefs]);
  return { prefs, setPrefs, reduced };
}
