export function applyPromotions(lines, customer) {
  const subtotal = lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);
  if (customer.segment === "vip" && subtotal >= 150_000) {
    return [...lines, { sku: "GIFT-SLEEVE", name: "Promotional Sleeve", priceCents: 0, quantity: 1 }];
  }
  return lines;
}
