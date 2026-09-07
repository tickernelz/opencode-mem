export function getDisplayedMemoryCount(
  isSearching: boolean,
  searchTotal: number,
  storeTotal: number
): number {
  return isSearching ? searchTotal : storeTotal;
}
