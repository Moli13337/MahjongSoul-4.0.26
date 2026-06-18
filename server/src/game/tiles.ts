/**
 * Majsoul tile string utilities.
 *
 * Majsoul tile format: "0m"/"0p"/"0s" = red 5s, "1z".."7z" = honors.
 * Internal format: same as Majsoul (used directly in liqi protocol).
 */

/** All 37 tile strings in Majsoul format (including 3 red fives) */
export const ALL_TILES: string[] = [
  '1m', '2m', '3m', '4m', '0m', '5m', '6m', '7m', '8m', '9m',
  '1p', '2p', '3p', '4p', '0p', '5p', '6p', '7p', '8p', '9p',
  '1s', '2s', '3s', '4s', '0s', '5s', '6s', '7s', '8s', '9s',
  '1z', '2z', '3z', '4z', '5z', '6z', '7z',
];

/** Check if a tile string is a red five */
export function isRedFive(tile: string): boolean {
  return tile === '0m' || tile === '0p' || tile === '0s';
}

/** Get the normal (non-red) equivalent of a tile */
export function toNormalTile(tile: string): string {
  if (tile === '0m') return '5m';
  if (tile === '0p') return '5p';
  if (tile === '0s') return '5s';
  return tile;
}

/** Compare two tiles for sorting (Majsoul canonical order) */
export function compareTiles(a: string, b: string): number {
  const order = [
    '1m', '2m', '3m', '4m', '0m', '5m', '6m', '7m', '8m', '9m',
    '1p', '2p', '3p', '4p', '0p', '5p', '6p', '7p', '8p', '9p',
    '1s', '2s', '3s', '4s', '0s', '5s', '6s', '7s', '8s', '9s',
    '1z', '2z', '3z', '4z', '5z', '6z', '7z',
  ];
  const ai = order.indexOf(a);
  const bi = order.indexOf(b);
  return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
}

/** Sort an array of tile strings in place */
export function sortTiles(tiles: string[]): string[] {
  return tiles.sort(compareTiles);
}
