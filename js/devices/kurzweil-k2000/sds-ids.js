// Where the K2000 stores an incoming Sample Dump (firmware 3.87, FUN_0017bdfa).

/**
 * Sample number to put in an SDS header so the K2000 stores the sample at `id`.
 * Firmware 3.87 stores an incoming sample at number + 1, adds 200 when that is below
 * 200, and uses the first free ID from 200 when the number is 0. IDs below 200 cannot
 * be reached by SDS. (Dump requests use the ID itself, see sdsSampleNumber.)
 */
export function sdsNumberForId(id) { return Math.max(199, Math.min(998, id - 1)); }

/** Where the K2000 stores an incoming SDS sample: the firmware rule above. */
export function sdsIdForNumber(number, isUsed = () => false) {
  let id = (number & 0x3ff) + 1;
  if (id === 1) {
    id = 200;
    while (isUsed(id) && id < 999) id++;
    return id;
  }
  if (id < 200) id += 200;
  return id;
}
