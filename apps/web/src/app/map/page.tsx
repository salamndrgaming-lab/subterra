import type { Metadata } from 'next';
import { MapDashboard } from '@/components/map/map-dashboard';

export const metadata: Metadata = {
  title: 'Map',
  description: 'Interactive map dashboard — wells, claims, parcels, federal lands.',
};

export default function MapPage() {
  return <MapDashboard />;
}
