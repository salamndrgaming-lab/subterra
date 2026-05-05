/**
 * Major North American oil & gas basins.
 */
export const BASINS = [
  { id: 'permian', label: 'Permian Basin', states: ['TX', 'NM'] },
  { id: 'bakken', label: 'Bakken / Williston', states: ['ND', 'MT', 'SD'] },
  { id: 'eagle_ford', label: 'Eagle Ford', states: ['TX'] },
  { id: 'haynesville', label: 'Haynesville', states: ['TX', 'LA', 'AR'] },
  { id: 'marcellus', label: 'Marcellus', states: ['PA', 'WV', 'OH', 'NY'] },
  { id: 'utica', label: 'Utica', states: ['OH', 'PA', 'WV'] },
  { id: 'niobrara', label: 'Niobrara / DJ', states: ['CO', 'WY'] },
  { id: 'powder_river', label: 'Powder River Basin', states: ['WY', 'MT'] },
  { id: 'anadarko', label: 'Anadarko / SCOOP / STACK', states: ['OK', 'TX'] },
  { id: 'uinta', label: 'Uinta Basin', states: ['UT'] },
  { id: 'piceance', label: 'Piceance Basin', states: ['CO'] },
  { id: 'san_juan', label: 'San Juan Basin', states: ['NM', 'CO'] },
  { id: 'appalachian', label: 'Appalachian Basin', states: ['PA', 'WV', 'OH', 'KY'] },
  { id: 'fort_worth', label: 'Fort Worth / Barnett', states: ['TX'] },
] as const;

export type BasinId = typeof BASINS[number]['id'];
