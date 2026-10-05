import { findProducts } from "../repositories/catalog-repository.mjs";
import { loadCustomerContext } from "./customer-service.mjs";
import { applyPromotions } from "./promotion-service.mjs";
import { buildReservationPlan } from "./inventory-service.mjs";

export async function checkout(input) {
  const [customer, catalogLines] = await Promise.all([
    loadCustomerContext(input.customerId),
    Promise.resolve(findProducts(input.lines)),
  ]);
  const promotedLines = applyPromotions(catalogLines, customer);
  const reservations = buildReservationPlan(promotedLines);
  return {
    orderId: `ORDER-${Date.now()}`,
    totalCents: promotedLines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0),
    reservations,
  };
}
