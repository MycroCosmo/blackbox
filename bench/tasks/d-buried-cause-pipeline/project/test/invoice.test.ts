import { describe, expect, it } from "vitest";
import { grossCents } from "../src/invoice.js";

describe("invoice gross prices", () => {
  it.each([
    ["SKU-0001", 20678],
    ["SKU-0002", 13434],
    ["SKU-0003", 6872],
    ["SKU-0004", 8898],
    ["SKU-0005", 18371],
    ["SKU-0006", 19237],
    ["SKU-0007", 20418],
    ["SKU-0008", 2032],
    ["SKU-0009", 6994],
    ["SKU-0010", 13922],
    ["SKU-0011", 19268],
    ["SKU-0012", 20553],
    ["SKU-0013", 928],
    ["SKU-0014", 21165],
    ["SKU-0015", 19028],
    ["SKU-0016", 16125],
    ["SKU-0017", 23126],
    ["SKU-0018", 5868],
    ["SKU-0019", 4160],
    ["SKU-0020", 10951],
    ["SKU-0021", 10574],
    ["SKU-0022", 21023],
    ["SKU-0023", 19723],
    ["SKU-0024", 6381],
    ["SKU-0025", 7889],
    ["SKU-0026", 3088],
    ["SKU-0027", 3291],
    ["SKU-0028", 10685],
    ["SKU-0029", 7818],
    ["SKU-0030", 20633],
  ])("%s gross price includes VAT", (sku, expected) => {
    expect(grossCents(sku)).toBe(expected);
  });
});
