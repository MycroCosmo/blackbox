export interface FormatOptions {
  currency: string;
  minorUnits: number;
  locale: string;
}

const DEFAULT_OPTIONS: FormatOptions = {
  currency: "USD",
  minorUnits: 2,
  locale: "en-US",
};

export function resolveOptions(overrides: Partial<FormatOptions> = {}): FormatOptions {
  return Object.assign(DEFAULT_OPTIONS, overrides);
}
