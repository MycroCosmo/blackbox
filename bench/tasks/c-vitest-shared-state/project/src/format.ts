import { resolveOptions, type FormatOptions } from "./options.js";

const SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  JPY: "¥",
  KRW: "₩",
};

/** Formats an amount stored in minor units (cents, etc.). */
export function formatMoney(amountMinor: number, overrides?: Partial<FormatOptions>): string {
  const opts = resolveOptions(overrides);
  const major = Math.abs(amountMinor) / 10 ** opts.minorUnits;
  const digits = major.toLocaleString(opts.locale, {
    minimumFractionDigits: opts.minorUnits,
    maximumFractionDigits: opts.minorUnits,
  });
  const symbol = SYMBOLS[opts.currency] ?? `${opts.currency} `;
  return `${amountMinor < 0 ? "-" : ""}${symbol}${digits}`;
}
