export type UserRole = 'admin' | 'pro' | 'free';

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
  isVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthSession {
  user: User;
  tokens: AuthTokens;
}
