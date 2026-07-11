// Small internal string helpers shared across the SDK. Not exported from the
// package barrel (`index.ts`) and unreachable via the `exports` map, so this is
// private surface. The vendored `crypto/` port keeps its own copies to stay
// byte-identical to upstream and deliberately does not import from here.

/** Strips trailing "/" characters. A manual scan rather than `replace(/\/+$/, "")`
 * so it is linear on any input (the regex form is polynomial-ReDoS on a long run
 * of slashes over caller-supplied input, e.g. a `baseUrl` option). */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* "/" */) {
    end--;
  }
  return end === url.length ? url : url.slice(0, end);
}

/** Extracts a human-readable message from an unknown thrown value. */
export function errText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
