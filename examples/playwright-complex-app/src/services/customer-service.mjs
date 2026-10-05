export async function loadCustomerContext(customerId) {
  await Promise.resolve();
  return {
    customerId,
    segment: customerId.startsWith("VIP-") ? "vip" : "standard",
    paymentRisk: "low",
  };
}
