/**
 * Credential shapes scrubbed before anything reaches the store.
 *
 * Deliberately NOT included: plain email addresses. Redacting every address
 * silently destroyed legitimate memories ("contact ops@example.com") and an
 * address is not a credential. The store is plaintext either way. A missed
 * pattern leaks, so this list errs toward matching.
 */
const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/g, // covers sk-ant-…, sk-proj-…, sk-or-…
  /ghp_[A-Za-z0-9]{10,}/g,
  /gho_[A-Za-z0-9]{10,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[bpas]-[A-Za-z0-9-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token)\s*[:=]\s*\S+/gi,
  /\bbearer\s+[A-Za-z0-9._~+/-]+/gi,
];

export interface RedactionResult {
  text: string;
  redacted: boolean;
  count: number;
}

export function redactSecrets(text: string): RedactionResult {
  let count = 0;
  let out = text;
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, () => {
      count++;
      return "[REDACTED secret]";
    });
  }
  return { text: out, redacted: count > 0, count };
}
