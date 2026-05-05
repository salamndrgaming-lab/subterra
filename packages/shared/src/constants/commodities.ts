export const COMMODITIES = [
  { id: 'gold', label: 'Gold', symbol: 'Au', category: 'precious' },
  { id: 'silver', label: 'Silver', symbol: 'Ag', category: 'precious' },
  { id: 'platinum', label: 'Platinum', symbol: 'Pt', category: 'precious' },
  { id: 'palladium', label: 'Palladium', symbol: 'Pd', category: 'precious' },
  { id: 'copper', label: 'Copper', symbol: 'Cu', category: 'base' },
  { id: 'lead', label: 'Lead', symbol: 'Pb', category: 'base' },
  { id: 'zinc', label: 'Zinc', symbol: 'Zn', category: 'base' },
  { id: 'tin', label: 'Tin', symbol: 'Sn', category: 'base' },
  { id: 'molybdenum', label: 'Molybdenum', symbol: 'Mo', category: 'base' },
  { id: 'lithium', label: 'Lithium', symbol: 'Li', category: 'critical' },
  { id: 'cobalt', label: 'Cobalt', symbol: 'Co', category: 'critical' },
  { id: 'nickel', label: 'Nickel', symbol: 'Ni', category: 'critical' },
  { id: 'rare_earth', label: 'Rare Earth Elements', symbol: 'REE', category: 'critical' },
  { id: 'uranium', label: 'Uranium', symbol: 'U', category: 'energy' },
  { id: 'oil', label: 'Crude Oil', symbol: 'OIL', category: 'energy' },
  { id: 'gas', label: 'Natural Gas', symbol: 'GAS', category: 'energy' },
  { id: 'helium', label: 'Helium', symbol: 'He', category: 'energy' },
  { id: 'coal', label: 'Coal', symbol: 'C', category: 'energy' },
  { id: 'potash', label: 'Potash', symbol: 'KCl', category: 'industrial' },
  { id: 'phosphate', label: 'Phosphate', symbol: 'P', category: 'industrial' },
  { id: 'gypsum', label: 'Gypsum', symbol: 'CaSO4', category: 'industrial' },
  { id: 'sand_gravel', label: 'Sand & Gravel', symbol: 'SG', category: 'industrial' },
] as const;

export type CommodityId = typeof COMMODITIES[number]['id'];
export type CommodityCategory = typeof COMMODITIES[number]['category'];
