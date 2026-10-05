import { expect, it } from "vitest";
import { priceBadge } from "../src/badge.js";
import { formatMoney } from "../src/format.js";

// Verification-only test: overrides from one call must never leak into the next,
// and per-call options (currency, minor units) must still work.
it("keeps per-call options isolated", () => {
  expect(formatMoney(150000, { currency: "JPY", minorUnits: 0 })).toBe("¥150,000");
  expect(formatMoney(1999)).toBe("$19.99");
  expect(priceBadge(1999)).toBe("$20");
  expect(formatMoney(-500)).toBe("-$5.00");
  expect(formatMoney(1234, { currency: "EUR" })).toBe("€12.34");
  expect(formatMoney(1999)).toBe("$19.99");
});
