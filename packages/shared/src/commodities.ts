/** Commodities tracked by the scoring engine. EIA series IDs are used by
 * the daily price refresh in `etl/sources/commodity_prices.py`. */

export interface Commodity {
  id: string;
  label: string;
  symbol: string;
  category: 'precious' | 'base' | 'critical' | 'energy' | 'industrial';
  /** EIA OpenData series ID, when available. Empty string = no live price. */
  eiaSeries: string;
}

export const COMMODITIES: readonly Commodity[] = [
  { id: 'gold', label: 'Gold', symbol: 'Au', category: 'precious', eiaSeries: '' },
  { id: 'silver', label: 'Silver', symbol: 'Ag', category: 'precious', eiaSeries: '' },
  { id: 'platinum', label: 'Platinum', symbol: 'Pt', category: 'precious', eiaSeries: '' },
  { id: 'palladium', label: 'Palladium', symbol: 'Pd', category: 'precious', eiaSeries: '' },
  { id: 'copper', label: 'Copper', symbol: 'Cu', category: 'base', eiaSeries: '' },
  { id: 'lead', label: 'Lead', symbol: 'Pb', category: 'base', eiaSeries: '' },
  { id: 'zinc', label: 'Zinc', symbol: 'Zn', category: 'base', eiaSeries: '' },
  { id: 'molybdenum', label: 'Molybdenum', symbol: 'Mo', category: 'base', eiaSeries: '' },
  { id: 'lithium', label: 'Lithium', symbol: 'Li', category: 'critical', eiaSeries: '' },
  { id: 'cobalt', label: 'Cobalt', symbol: 'Co', category: 'critical', eiaSeries: '' },
  { id: 'nickel', label: 'Nickel', symbol: 'Ni', category: 'critical', eiaSeries: '' },
  { id: 'rare_earth', label: 'Rare Earth Elements', symbol: 'REE', category: 'critical', eiaSeries: '' },
  { id: 'uranium', label: 'Uranium', symbol: 'U', category: 'energy', eiaSeries: '' },
  { id: 'oil', label: 'Crude Oil (WTI)', symbol: 'OIL', category: 'energy', eiaSeries: 'PET.RWTC.D' },
  { id: 'gas', label: 'Natural Gas (Henry Hub)', symbol: 'GAS', category: 'energy', eiaSeries: 'NG.RNGWHHD.D' },
  { id: 'helium', label: 'Helium', symbol: 'He', category: 'energy', eiaSeries: '' },
  { id: 'coal', label: 'Coal', symbol: 'C', category: 'energy', eiaSeries: '' },
  { id: 'potash', label: 'Potash', symbol: 'KCl', category: 'industrial', eiaSeries: '' },
  { id: 'phosphate', label: 'Phosphate', symbol: 'P', category: 'industrial', eiaSeries: '' },
  { id: 'sand_gravel', label: 'Sand & Gravel', symbol: 'SG', category: 'industrial', eiaSeries: '' },
] as const;

export type CommodityId = (typeof COMMODITIES)[number]['id'];
export type CommodityCategory = Commodity['category'];
