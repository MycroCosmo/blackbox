import { describe, expect, it } from "vitest";
import { grossCents } from "../src/invoice.js";

describe("hidden regions", () => {
  it.each([
    ["SKU-0033", 12694],
    ["SKU-0035", 8632],
    ["SKU-0043", 15558],
    ["SKU-0044", 9941],
  ])("%s gross price includes VAT", (sku, expected) => {
    expect(grossCents(sku)).toBe(expected);
  });
});
