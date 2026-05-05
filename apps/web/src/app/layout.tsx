import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { AppProviders } from '@/components/providers';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: {
    default: 'Subterra · Geospatial intelligence for prospectors',
    template: '%s · Subterra',
  },
  description: 'Land, mineral, oil/gas, and mining opportunity aggregation. One map, every public dataset.',
  metadataBase: new URL('https://subterra.app'),
  icons: { icon: '/favicon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#0a0c10',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} dark`}>
      <body className="bg-bg text-text antialiased">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
