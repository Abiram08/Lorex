/** Secret redaction before storage. Defensive: a missed pattern leaks, a false positive just redacts. */

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9-_]{10,}/g,
  /sk-[A-Za-z0-9]{10,}/g,
  /ghp_[A-Za-z0-9]{10,}/g,
  /gho_[A-Za-z0-9]{10,}/g,
  /xox[bpas]-[A-Za-z0-9-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token)\s*[:=]\s*\S+/gi,
  /\bbearer\s+[A-Za-z0-9._~+/-]+/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
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
    out = out.replace(pattern, (m) => {
      count++;
      const label = m.includes("@") ? "email" : "secret";
      return `[REDACTED ${label}]`;
    });
  }
  return { text: out, redacted: count > 0, count };
}
