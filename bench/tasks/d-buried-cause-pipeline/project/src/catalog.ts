import fs from "node:fs";

export interface Product {
  sku: string;
  region: string;
  category: string;
  netCents: number;
  image: string;
}

export interface Catalog {
  taxTable: Record<string, { rate: number; label: string }>;
  products: Product[];
}

export const catalog: Catalog = JSON.parse(
  fs.readFileSync(new URL("../generated/catalog.json", import.meta.url), "utf8"),
);
