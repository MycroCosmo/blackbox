import { catalog } from "./catalog.js";
import { taxRate } from "./tax.js";

export function grossCents(sku: string): number {
  const product = catalog.products.find((p) => p.sku === sku);
  if (!product) throw new Error(`unknown SKU ${sku}`);
  return Math.round(product.netCents * (1 + taxRate(product.region)));
}
