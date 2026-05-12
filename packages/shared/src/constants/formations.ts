/**
 * Common producing formations (target zones) by basin.
 */
export const FORMATIONS_BY_BASIN: Record<string, string[]> = {
  permian: ['Wolfcamp A', 'Wolfcamp B', 'Wolfcamp C', 'Wolfcamp D', 'Bone Spring', 'Spraberry', 'Avalon', 'Yeso'],
  bakken: ['Middle Bakken', 'Three Forks', 'Lodgepole', 'Pronghorn'],
  eagle_ford: ['Eagle Ford Lower', 'Eagle Ford Upper', 'Austin Chalk', 'Buda'],
  haynesville: ['Haynesville', 'Bossier', 'Cotton Valley'],
  marcellus: ['Marcellus', 'Point Pleasant', 'Utica'],
  niobrara: ['Niobrara A', 'Niobrara B', 'Niobrara C', 'Codell', 'Sussex'],
  powder_river: ['Niobrara', 'Mowry', 'Frontier', 'Turner', 'Sussex', 'Parkman'],
  anadarko: ['Woodford', 'Mississippi Lime', 'Cana', 'Sycamore', 'Meramec'],
  uinta: ['Uteland Butte', 'Wasatch', 'Mesaverde', 'Mancos'],
  piceance: ['Mancos', 'Mesaverde', 'Williams Fork'],
  san_juan: ['Mancos', 'Fruitland Coal', 'Pictured Cliffs'],
  appalachian: ['Marcellus', 'Utica', 'Point Pleasant', 'Berea'],
  fort_worth: ['Barnett'],
};
