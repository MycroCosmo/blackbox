import { createRequire } from "node:module";

/** Single source of truth for the package version.
 *
 *  Both `src/` and the compiled `dist/` sit one level under the package root,
 *  so this resolves identically in development and in the published package.
 *  Hardcoded copies (CLI --version, MCP serverInfo) used to drift apart. */
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;
