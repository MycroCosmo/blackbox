/** Sensitive-data masking (spec 8). Applied to every log line BEFORE it is
 *  buffered, so raw secrets never reach disk or temp files. */

const REDACTED = "[REDACTED]";

const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;
const PRIVATE_KEY_BEGIN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END_RE = /-----END [A-Z ]*PRIVATE KEY-----/;
const COMMON_SECRET_KEY_RE =
  /(?:password|passwd|token|secret|authorization|cookie|api.?key|private.?key)$/i;

// These deliberately capture a broad key shape and defer the security
// decision to isSensitiveKey(). That keeps separator/casing variants such as
// x-api-key, private_key and DB_PASSWORD consistent across objects and text.
const DOUBLE_QUOTED_PAIR_RE = /("([^"\\\r\n]+)"\s*:\s*)("(?:\\.|[^"\\])*")/g;
const SINGLE_QUOTED_PAIR_RE = /('([^'\\\r\n]+)'\s*:\s*)('(?:\\.|[^'\\])*')/g;
const HEADER_PAIR_RE = /^(\s*)([A-Za-z0-9_.\-/]+)(\s*:\s*)(\S.*)$/gm;
const ASSIGNMENT_PAIR_RE =
  /(^|[^A-Za-z0-9_.\-/])([A-Za-z0-9_.\-/]+)(\s*=\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s&;]+)/gm;

/** Value-shaped secrets that are masked regardless of the key they follow. */
const VALUE_PATTERNS: RegExp[] = [
  // JWT: three base64url segments starting with eyJ
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Bearer tokens
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/g,
];

export class Redactor {
  private readonly normalizedKeySet: Set<string>;
  private insidePrivateKey = false;

  constructor(redactKeys: string[]) {
    this.normalizedKeySet = new Set(redactKeys.map(normalizeKey));
  }

  /** Stateless masking for self-contained text (object fields, URLs, argv).
   *  A private-key block must be fully contained in the input; lone BEGIN/END
   *  marker lines are still redacted, but no state carries to the next call. */
  redactLine(line: string): string {
    let out = line.replace(PRIVATE_KEY_BLOCK_RE, REDACTED);
    if (PRIVATE_KEY_BEGIN_RE.test(out) || PRIVATE_KEY_END_RE.test(out)) {
      return REDACTED;
    }
    out = out.replace(
      DOUBLE_QUOTED_PAIR_RE,
      (match, prefix: string, key: string) =>
        this.isSensitiveKey(key) ? `${prefix}"${REDACTED}"` : match,
    );
    out = out.replace(
      SINGLE_QUOTED_PAIR_RE,
      (match, prefix: string, key: string) =>
        this.isSensitiveKey(key) ? `${prefix}'${REDACTED}'` : match,
    );
    out = out.replace(
      HEADER_PAIR_RE,
      (match, leading: string, key: string, separator: string) =>
        this.isSensitiveKey(key) ? `${leading}${key}${separator}${REDACTED}` : match,
    );
    out = out.replace(
      ASSIGNMENT_PAIR_RE,
      (match, leading: string, key: string, separator: string) =>
        this.isSensitiveKey(key)
          ? `${leading}${key}${separator}${REDACTED}`
          : match,
    );
    for (const re of VALUE_PATTERNS) {
      out = out.replace(re, REDACTED);
    }
    return out;
  }

  /** Stateful variant for streamed output, where a private-key block spans
   *  multiple lines. The BEGIN/END state is per-instance, so use a dedicated
   *  Redactor per stream/run — never share one across independent inputs
   *  (that is how one truncated key poisoned every later collector event). */
  redactStreamLine(line: string): string {
    if (this.insidePrivateKey) {
      if (PRIVATE_KEY_END_RE.test(line)) this.insidePrivateKey = false;
      return REDACTED;
    }
    const withoutBlocks = line.replace(PRIVATE_KEY_BLOCK_RE, REDACTED);
    if (PRIVATE_KEY_BEGIN_RE.test(withoutBlocks)) this.insidePrivateKey = true;
    return this.redactLine(line);
  }

  /** Masks credentials in a URL without discarding its replay/debug shape. */
  redactUrl(value: string): string {
    if (!looksLikeUrl(value)) return this.redactLine(value);
    if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value)) {
      try {
        const url = new URL(value);
        if (url.username) url.username = REDACTED;
        if (url.password) url.password = REDACTED;
        for (const key of [...url.searchParams.keys()]) {
          if (this.isSensitiveKey(key)) url.searchParams.set(key, REDACTED);
        }
        return this.redactLine(url.toString());
      } catch {
        return this.redactLine(value);
      }
    }
    // Relative URL: replay resolves it against a base URL later, so the
    // recorded path shape (leading slash, ./, ../ or none) must survive
    // verbatim — "api/x" vs "/api/x" hit different endpoints when the base
    // has a path. Only the query string is rewritten.
    const hashIndex = value.indexOf("#");
    const hash = hashIndex === -1 ? "" : value.slice(hashIndex);
    const withoutHash = hashIndex === -1 ? value : value.slice(0, hashIndex);
    const queryIndex = withoutHash.indexOf("?");
    if (queryIndex === -1) return this.redactLine(value);
    const params = new URLSearchParams(withoutHash.slice(queryIndex + 1));
    for (const key of [...params.keys()]) {
      if (this.isSensitiveKey(key)) params.set(key, REDACTED);
    }
    return this.redactLine(`${withoutHash.slice(0, queryIndex)}?${params.toString()}${hash}`);
  }

  /** Formats argv for persistence while keeping the raw argv only in memory
   *  for spawning. Separate secret flag values are masked as well. */
  redactCommand(argv: readonly string[]): string {
    const redacted: string[] = [];
    let redactNext = false;
    for (const raw of argv) {
      if (redactNext) {
        redacted.push(REDACTED);
        redactNext = false;
        continue;
      }

      const isUrl = looksLikeUrl(raw);
      const assignment = isUrl ? null : /^([^=]+)=(.*)$/s.exec(raw);
      if (assignment && this.isSensitiveKey(assignment[1]!)) {
        redacted.push(`${assignment[1]}=${REDACTED}`);
        continue;
      }

      if (/^--?[^=]+$/.test(raw) && this.isSensitiveKey(raw)) {
        redacted.push(raw);
        redactNext = true;
        continue;
      }

      const safe = isUrl ? this.redactUrl(raw) : this.redactLine(raw);
      redacted.push(safe);
    }
    return redacted.map(formatArg).join(" ");
  }

  /** Recursively masks matching keys inside a JSON-compatible value. */
  redactObject<T>(value: T): T {
    if (Array.isArray(value)) {
      return value.map((v) => this.redactObject(v)) as T;
    }
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = this.isSensitiveKey(k) ? REDACTED : this.redactObject(v);
      }
      return out as T;
    }
    if (typeof value === "string") {
      return this.redactLine(value) as T;
    }
    return value;
  }

  private isSensitiveKey(key: string): boolean {
    const normalized = normalizeKey(key);
    return this.normalizedKeySet.has(normalized) || COMMON_SECRET_KEY_RE.test(normalized);
  }
}

function normalizeKey(key: string): string {
  const leaf = key.replace(/^[-/]+/, "").split(/[.:/]/).pop() ?? key;
  return leaf.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function formatArg(arg: string): string {
  return arg === "" || /\s|["'`]/.test(arg) ? JSON.stringify(arg) : arg;
}

function looksLikeUrl(value: string): boolean {
  return (
    /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value) ||
    /^(?:\/|\.\/|\.\.\/|\?)/.test(value) ||
    (!/\s/.test(value) && value.includes("?"))
  );
}
