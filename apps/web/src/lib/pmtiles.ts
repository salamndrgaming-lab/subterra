/**
 * Register the `pmtiles://` protocol with MapLibre so a single .pmtiles
 * file on R2 can be range-requested as if it were a vector tile source.
 *
 * Call once at app startup, before any `new maplibregl.Map(...)`.
 */

import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';

let registered = false;

export function registerPmtilesProtocol(): void {
  if (registered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  registered = true;
}
