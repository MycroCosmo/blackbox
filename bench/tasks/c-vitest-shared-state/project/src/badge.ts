import { formatMoney } from "./format.js";

/** Whole-dollar price for compact UI badges, e.g. 1999 -> "$20". */
export function priceBadge(amountMinor: number): string {
  return formatMoney(Math.round(amountMinor / 100), { minorUnits: 0 });
}
