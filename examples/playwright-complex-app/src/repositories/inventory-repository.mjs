// The legacy warehouse sync incorrectly excludes zero-price promotional SKUs.
const warehouseRows = new Map([
  ["LAPTOP-PRO", { available: 8, warehouse: "ICN-1" }],
  ["USB-C-DOCK", { available: 23, warehouse: "ICN-1" }],
]);

export function findWarehouseRow(sku) {
  return warehouseRows.get(sku);
}
