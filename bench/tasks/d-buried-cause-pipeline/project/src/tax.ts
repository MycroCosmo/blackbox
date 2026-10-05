import { catalog } from "./catalog.js";

export function taxRate(region: string): number {
  return catalog.taxTable[region].rate;
}
