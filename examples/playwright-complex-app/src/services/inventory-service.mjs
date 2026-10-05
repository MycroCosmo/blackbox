import { findWarehouseRow } from "../repositories/inventory-repository.mjs";

export function buildReservationPlan(lines) {
  return lines.map((line) => {
    const stock = findWarehouseRow(line.sku);
    // Intentional production-like bug: the promotion service can add a SKU
    // which the warehouse sync omitted, but this boundary assumes it exists.
    if (stock.available < line.quantity) {
      throw new Error(`Insufficient stock for ${line.sku}`);
    }
    return { sku: line.sku, quantity: line.quantity, warehouse: stock.warehouse };
  });
}
