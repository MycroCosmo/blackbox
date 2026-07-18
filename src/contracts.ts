import fs from "node:fs";
import path from "node:path";
import type { Storage } from "./storage.js";

/** Response contract checking (spec 5.4).
 *  Contracts are ONLY applied when the user registered them — API shapes are
 *  never inferred automatically. Register in `.dev-blackbox/contracts.json`:
 *
 *  {
 *    "contracts": [
 *      {
 *        "method": "GET",
 *        "route": "/api/user",
 *        "responseSchema": {
 *          "type": "object",
 *          "required": ["id", "userName"],
 *          "properties": { "id": { "type": "number" }, "userName": { "type": "string" } }
 *        }
 *      }
 *    ]
 *  }
 *
 *  The schema language is a pragmatic JSON-Schema subset: type, required,
 *  properties, items, enum. */

export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "boolean" | "null" | "integer";
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
}

export interface Contract {
  method: string;
  route: string;
  responseSchema: JsonSchema;
}

export interface ContractMismatch {
  path: string;
  expected: string;
  actual: string;
}

export function loadContracts(storage: Storage): Contract[] {
  try {
    const raw = fs.readFileSync(path.join(storage.root, "contracts.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.contracts)) return [];
    return parsed.contracts.filter(
      (c: unknown): c is Contract =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as Contract).method === "string" &&
        typeof (c as Contract).route === "string" &&
        typeof (c as Contract).responseSchema === "object",
    );
  } catch {
    return [];
  }
}

export function findContract(
  contracts: Contract[],
  method: string,
  url: string,
): Contract | undefined {
  const pathname = toPath(url);
  return contracts.find((c) => {
    if (c.method.toUpperCase() !== method.toUpperCase()) return false;
    return c.route.endsWith("*")
      ? pathname.startsWith(c.route.slice(0, -1))
      : pathname === c.route;
  });
}

function toPath(url: string): string {
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return url;
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Validates a value against the schema subset; returns mismatches (empty =
 *  contract satisfied). Limited to the first 20 mismatches. */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  atPath = "$",
  out: ContractMismatch[] = [],
): ContractMismatch[] {
  if (out.length >= 20) return out;

  if (schema.enum) {
    if (!schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
      out.push({ path: atPath, expected: `one of ${JSON.stringify(schema.enum)}`, actual: JSON.stringify(value) });
    }
    return out;
  }

  if (schema.type) {
    const actual = typeOf(value);
    const expected = schema.type === "integer" ? "number" : schema.type;
    if (actual !== expected || (schema.type === "integer" && !Number.isInteger(value))) {
      out.push({ path: atPath, expected: schema.type, actual });
      return out; // deeper checks are meaningless on the wrong type
    }
  }

  if (schema.type === "object" || schema.properties || schema.required) {
    if (typeOf(value) !== "object") {
      if (!schema.type) out.push({ path: atPath, expected: "object", actual: typeOf(value) });
      return out;
    }
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) {
        out.push({ path: `${atPath}.${key}`, expected: "present (required)", actual: "missing" });
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) validateAgainstSchema(obj[key], sub, `${atPath}.${key}`, out);
    }
  }

  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    value.forEach((item, i) => validateAgainstSchema(item, schema.items!, `${atPath}[${i}]`, out));
  }

  return out;
}
