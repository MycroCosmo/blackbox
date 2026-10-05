// Builds generated/catalog.json from data/. Runs before the test suite.
import fs from "node:fs";

const log = (level, message) => console.log(`[catalog] ${level} ${message}`);

function loadTaxTable() {
  try {
    return JSON.parse(fs.readFileSync("data/tax-rates.json", "utf8"));
  } catch (e) {
    // A partial catalog is better than none for local development.
    log("ERROR", "could not load data/tax-rates.json; continuing with an empty tax table");
    console.log(e.stack);
    return {};
  }
}

function loadProducts() {
  const [header, ...rows] = fs.readFileSync("data/products.csv", "utf8").trim().split("\n");
  const cols = header.split(",");
  return rows.map((row) => {
    const values = row.split(",");
    const record = Object.fromEntries(cols.map((c, i) => [c, values[i]]));
    return {
      sku: record.sku,
      region: record.region,
      category: record.category,
      netCents: Number(record.net_cents),
      image: record.image || "img/placeholder.png",
    };
  });
}

log("INFO", "building catalog from data/");
const taxTable = loadTaxTable();
log("INFO", `tax regions loaded: ${Object.keys(taxTable).length}`);
const products = loadProducts();
for (const p of products) {
  if (p.image === "img/placeholder.png") log("WARN", `${p.sku} has no image; using placeholder`);
  log("INFO", `normalized ${p.sku} region=${p.region} category=${p.category} net=${p.netCents}`);
}
fs.mkdirSync("generated", { recursive: true });
fs.writeFileSync("generated/catalog.json", JSON.stringify({ taxTable, products }, null, 2));
log("INFO", `wrote generated/catalog.json (${products.length} products)`);
