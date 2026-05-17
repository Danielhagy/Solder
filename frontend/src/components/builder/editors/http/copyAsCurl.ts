/*
 * copyAsCurl — pure function that turns the resolved HTTP request shape
 * into a one-liner cURL command. Sensitive header values are NOT masked
 * here — callers decide whether to surface the raw secret (Response
 * drawer's "Copy as cURL" assumes the user trusts their own clipboard).
 */

function shellQuote(s: string): string {
  // POSIX-style single-quote escape. cURL is happiest with single quotes;
  // embedded single quotes get closed-escaped-reopened.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface CurlInput {
  method: string;
  url: string;
  headers?: Array<[string, string]> | Record<string, string>;
  body?: unknown;
}

export function copyAsCurl(input: CurlInput): string {
  const parts: string[] = ['curl', '-X', input.method.toUpperCase()];

  // Headers (skip ones cURL synthesises itself).
  const skip = new Set(['host', 'content-length']);
  const entries: Array<[string, string]> = Array.isArray(input.headers)
    ? input.headers
    : input.headers
      ? Object.entries(input.headers)
      : [];
  for (const [k, v] of entries) {
    if (skip.has(k.toLowerCase())) continue;
    parts.push('-H', shellQuote(`${k}: ${v}`));
  }

  // Body — if present, encode appropriately.
  if (input.body !== undefined && input.body !== null && input.body !== '') {
    const isStringBody = typeof input.body === 'string';
    const text = isStringBody ? (input.body as string) : JSON.stringify(input.body);
    parts.push('--data-raw', shellQuote(text));
  }

  parts.push(shellQuote(input.url));
  return parts.join(' ');
}
