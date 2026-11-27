export function containsSecret(value: string): boolean {
  return /-----BEGIN[ A-Z]*PRIVATE KEY-----|\b(?:sk-[a-z0-9_-]{16,}|(?:gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[a-z0-9_-]{12,})\b|\b(?:password|passwd|passphrase|(?:api|access|secret|private)[ _-]?key|(?:auth|access|refresh)[ _-]?token|client[ _-]?secret|seed phrase)\s*(?::|=|is\b)\s*\S|\b(?:authorization\s*:\s*)?bearer\s+[a-z0-9._~-]{12,}|:\/\/[^\s/:]+:[^\s/@]+@/iu.test(
    value,
  );
}
