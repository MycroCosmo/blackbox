import { formatMoney } from "./format.js";

export interface CartLine {
  sku: string;
  unitPriceMinor: number;
  quantity: number;
}

export function cartTotalMinor(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);
}

export function cartSummary(lines: CartLine[]): string {
  const items = lines.reduce((sum, line) => sum + line.quantity, 0);
  return `${items} items · ${formatMoney(cartTotalMinor(lines))}`;
}
