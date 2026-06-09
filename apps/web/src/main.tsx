import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { registerPmtilesProtocol } from './lib/pmtiles';
import { registerSW } from './lib/sw';
import { MapPage } from './routes/Map';
import { LandingPage } from './routes/Landing';
import { NotFoundPage } from './routes/NotFound';
import { SignInPage } from './routes/SignIn';

// One-time MapLibre <-> PMTiles protocol registration. Must happen
// before any <Map> component instantiates.
registerPmtilesProtocol();

// Register the offline-cache service worker (no-ops in dev).
registerSW();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/signin" element={<SignInPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
