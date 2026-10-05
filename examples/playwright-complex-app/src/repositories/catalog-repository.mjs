const products = new Map([
  ["LAPTOP-PRO", { sku: "LAPTOP-PRO", name: "Laptop Pro", priceCents: 189_900 }],
  ["USB-C-DOCK", { sku: "USB-C-DOCK", name: "USB-C Dock", priceCents: 19_900 }],
  ["GIFT-SLEEVE", { sku: "GIFT-SLEEVE", name: "Promotional Sleeve", priceCents: 0 }],
]);

export function findProducts(lines) {
  return lines.map(({ sku, quantity }) => {
    const product = products.get(sku);
    if (!product) throw new Error(`Unknown catalog SKU: ${sku}`);
    return { ...product, quantity };
  });
}
