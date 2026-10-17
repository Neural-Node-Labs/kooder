/**
 * The one rule this file exists to enforce: a raw credential must never
 * cross back into the LLM's context, a tool-call log, or the RAO trace.
 *
 * The Sub Agent only ever holds a `credentialRef` — the NAME of an
 * environment variable, not a value. Resolution happens here, at the last
 * possible moment, inside the tool execution that actually needs the
 * secret (the Playwright tool), and the resolved value never gets returned
 * to the caller. If you're tempted to add a `getCredentialValue` export
 * that hands the string back to a caller outside `tools/`, don't — that's
 * the exact mistake this module is here to prevent.
 */

export class CredentialResolutionError extends Error {}

export function resolveCredential(ref: string): string {
  const value = process.env[ref];
  if (!value) {
    throw new CredentialResolutionError(
      `credential ref "${ref}" is not set in the environment. Set it before running, e.g. ` +
        `\`${ref}=... xcoder -task "..."\`. Kooder never accepts a raw secret as a CLI argument ` +
        `or task input — only a reference to where it lives.`
    );
  }
  return value;
}

/** For anything that might echo a string containing a resolved secret (logs, RAO trace, errors). */
export function redact(text: string, ref?: string): string {
  if (!ref) return text;
  const value = process.env[ref];
  if (!value) return text;
  return text.split(value).join(`«redacted:${ref}»`);
}
