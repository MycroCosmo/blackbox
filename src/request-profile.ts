import type { Redactor } from "./security.js";

/** Optional language-neutral payload attached to one completed HTTP request. */
export interface RequestProfile {
  exception?: { type: string; message: string; stack: string[]; causes: { type: string; message: string; stack: string[] }[] };
  logs: string[];
  droppedLogs: number;
  truncated: boolean;
  incomplete: boolean;
}

export function buildProfile(input: unknown, redactor: Redactor): RequestProfile | undefined {
  if (input === undefined) return undefined;
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("profile must contain objects");
    return v as Record<string, unknown>;
  };
  const p = object(input);
  let truncated = p.truncated === true;
  // Reserve half for logs so a long exception chain cannot erase request evidence.
  let budget = 64 * 1024;
  const text = (v: unknown, limit = 4096): string => {
    if (typeof v !== "string") throw new Error("profile text must be a string");
    const safe = redactor.redactLine(v);
    const bytes = Buffer.from(safe);
    const max = Math.min(limit, budget);
    if (bytes.length > max) truncated = true;
    const out = new TextDecoder().decode(bytes.subarray(0, max), { stream: true });
    budget -= Buffer.byteLength(out);
    return out;
  };
  const lines = (v: unknown, limit: number, tail = false): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every(x => typeof x === "string")) throw new Error("profile lines must be strings");
    if (v.length > limit) truncated = true;
    // Mask the complete block before splitting: PEM bodies must not survive as separate lines.
    const safe = redactor.redactLine(v.join("\n")).split("\n");
    if (safe.length > limit) truncated = true;
    return tail ? safe.slice(-limit).reverse().map(s => text(s)).reverse() : safe.slice(0, limit).map(s => text(s));
  };
  let error: RequestProfile["exception"];
  if (p.exception !== undefined) {
    const e = object(p.exception);
    const causes = e.causes ?? [];
    if (!Array.isArray(causes)) throw new Error("exception.causes must be an array");
    if (causes.length > 16) truncated = true;
    // Preserve the deepest supplied cause even when a pathological chain is capped.
    const selected = causes.length > 16 ? [...causes.slice(0, 15), causes.at(-1)] : causes;
    const entries = [e, ...selected.map(object)];
    // Preserve every retained exception's identity before allocating stack space.
    const parsed = entries.map(entry => ({ type: text(entry.type, 256), message: text(entry.message ?? "", 2048), stack: [] as string[] }));
    for (let i = entries.length - 1; i >= 0; i--) parsed[i]!.stack = lines(entries[i]!.stack, 256);
    error = { ...parsed[0]!, causes: parsed.slice(1) };
  }
  budget += 64 * 1024;
  const logs = lines(p.logs, 500, true);
  const droppedLogs = typeof p.droppedLogs === "number" && Number.isSafeInteger(p.droppedLogs) && p.droppedLogs >= 0 ? p.droppedLogs : 0;
  return { exception: error, logs, droppedLogs, truncated, incomplete: p.incomplete === true };
}

export function applicationFrames(stack: string[]): string[] {
  const app = stack.filter(s => !/^\s*(?:at\s+)?(?:java\.|javax\.|jakarta\.|jdk\.|sun\.|org\.springframework\.|org\.apache\.|reactor\.)/.test(s));
  return (app.length ? app : stack).slice(0, 5);
}
