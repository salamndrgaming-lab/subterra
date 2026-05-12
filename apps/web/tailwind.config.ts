import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0a0c10',
          surface: '#111318',
          panel: '#161a22',
          elevated: '#1c2230',
        },
        border: {
          DEFAULT: '#1e2430',
          strong: '#2a3245',
        },
        accent: {
          DEFAULT: '#f59e0b',     // amber — geological warmth
          muted: '#b97a09',
          glow: 'rgba(245, 158, 11, 0.18)',
        },
        info: {
          DEFAULT: '#3b82f6',
          muted: '#1d4ed8',
        },
        success: {
          DEFAULT: '#10b981',
          muted: '#047857',
        },
        danger: {
          DEFAULT: '#ef4444',
          muted: '#b91c1c',
        },
        text: {
          DEFAULT: '#e2e8f0',
          muted: '#64748b',
          subtle: '#94a3b8',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui'],
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        'panel': '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.6)',
        'glow': '0 0 0 1px rgba(245, 158, 11, 0.3), 0 8px 24px -8px rgba(245, 158, 11, 0.25)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(245, 158, 11, 0.6)' },
          '50%': { boxShadow: '0 0 0 8px rgba(245, 158, 11, 0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out',
        'slide-in-right': 'slide-in-right 220ms cubic-bezier(0.32, 0.72, 0, 1)',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
