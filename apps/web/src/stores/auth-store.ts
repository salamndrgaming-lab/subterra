'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthTokens, User } from '@subterra/shared';

interface AuthState {
  user: User | null;
  tokens: AuthTokens | null;
  setSession: (user: User, tokens: AuthTokens) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      tokens: null,
      setSession: (user, tokens) => set({ user, tokens }),
      clear: () => set({ user: null, tokens: null }),
    }),
    { name: 'subterra-auth' },
  ),
);
