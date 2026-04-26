import { create } from 'zustand';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'solder-theme';

function systemPreference(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function readInitial(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return systemPreference();
}

function applyClass(theme: Theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
  root.dataset.theme = theme;
}

function persist(theme: Theme) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, theme);
}

interface ThemeState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const initial = readInitial();
applyClass(initial);

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initial,
  setTheme: (t) => {
    applyClass(t);
    persist(t);
    set({ theme: t });
  },
  toggle: () => {
    const next: Theme = get().theme === 'dark' ? 'light' : 'dark';
    applyClass(next);
    persist(next);
    set({ theme: next });
  }
}));

// Track the system preference while the user hasn't picked an explicit theme.
// Once they toggle (or set), `localStorage` has a value and we stop following.
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const onChange = (e: MediaQueryListEvent) => {
    if (window.localStorage.getItem(STORAGE_KEY)) return;
    const next: Theme = e.matches ? 'light' : 'dark';
    applyClass(next);
    useThemeStore.setState({ theme: next });
  };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
  else if (typeof mq.addListener === 'function') mq.addListener(onChange);
}
