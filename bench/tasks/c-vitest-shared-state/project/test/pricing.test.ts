import { describe, expect, it } from "vitest";
import { priceBadge } from "../src/badge.js";
import { cartSummary, cartTotalMinor, type CartLine } from "../src/cart.js";
import { formatMoney } from "../src/format.js";

const lines: CartLine[] = [
  { sku: "MUG", unitPriceMinor: 1499, quantity: 2 },
  { sku: "TEE", unitPriceMinor: 1999, quantity: 1 },
];

describe("priceBadge", () => {
  it("rounds to whole dollars", () => {
    expect(priceBadge(1999)).toBe("$20");
  });
});

describe("cart", () => {
  it("adds line totals in minor units", () => {
    expect(cartTotalMinor(lines)).toBe(4997);
  });

  it("summarizes item count and total", () => {
    expect(cartSummary(lines)).toBe("3 items · $49.97");
  });
});

describe("formatMoney", () => {
  it("formats cents as dollars", () => {
    expect(formatMoney(1999)).toBe("$19.99");
  });

  it("formats yen without minor units", () => {
    expect(formatMoney(150000, { currency: "JPY", minorUnits: 0 })).toBe("¥150,000");
  });

  it("formats negative amounts", () => {
    expect(formatMoney(-500)).toBe("-$5.00");
  });
});
