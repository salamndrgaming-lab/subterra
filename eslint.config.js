// Flat ESLint config (ESLint 9 style).
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  {
    ignores: [
      '**/dist/**',
      '**/.wrangler/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'apps/web/public/**',
      'etl/work/**',
      'etl/out/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        // Browser / DOM globals for the web app.
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        Blob: 'readonly',
        Image: 'readonly',
        XMLSerializer: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLFormElement: 'readonly',
        HTMLInputElement: 'readonly',
        SVGSVGElement: 'readonly',
        Element: 'readonly',
        Event: 'readonly',
        MessageEvent: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        Navigator: 'readonly',
        ServiceWorker: 'readonly',
        React: 'readonly',
        RequestInit: 'readonly',
        ResponseInit: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        // Cloudflare Worker globals.
        Response: 'readonly',
        Request: 'readonly',
        URL: 'readonly',
        crypto: 'readonly',
        D1Database: 'readonly',
        R2Bucket: 'readonly',
        R2Object: 'readonly',
        ExecutionContext: 'readonly',
        KVNamespace: 'readonly',
        GeoJSON: 'readonly',
        // Node globals (for ETL helpers + scripts).
        process: 'readonly',
        Buffer: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooks,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Node ESM scripts (deploy.mjs etc.) — Node globals.
    files: ['scripts/**/*.mjs', '**/*.config.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  prettier,
];
