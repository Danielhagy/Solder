import { create } from 'zustand';

export type Environment = 'sandbox' | 'production';

const STORAGE_KEY = 'solder-environment';

function readInitial(): Environment {
  if (typeof window === 'undefined') return 'sandbox';
  const saved = window.localStorage.getItem(STORAGE_KEY);
  return saved === 'production' ? 'production' : 'sandbox';
}

function persist(env: Environment) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, env);
}

interface EnvironmentState {
  environment: Environment;
  setEnvironment: (e: Environment) => void;
  toggle: () => void;
}

export const useEnvironmentStore = create<EnvironmentState>((set, get) => ({
  environment: readInitial(),
  setEnvironment: (e) => {
    persist(e);
    set({ environment: e });
  },
  toggle: () => {
    const next: Environment = get().environment === 'sandbox' ? 'production' : 'sandbox';
    persist(next);
    set({ environment: next });
  }
}));
