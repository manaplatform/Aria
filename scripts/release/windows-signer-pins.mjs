const fingerprintPattern = /^[a-f0-9]{64}$/;

export function windowsSignerPins(env, { required = false } = {}) {
  const primary = env.ARIA_WINDOWS_SIGNER_SHA256?.trim().toLowerCase();
  if (!primary) {
    if (required) throw new Error('Set ARIA_WINDOWS_SIGNER_SHA256 in the aria-windows-signing environment.');
    return [];
  }
  if (!fingerprintPattern.test(primary))
    throw new Error('ARIA_WINDOWS_SIGNER_SHA256 must be a 64-character SHA-256 fingerprint in hex without separators.');

  const additional = env.ARIA_WINDOWS_ADDITIONAL_SIGNERS_SHA256?.trim();
  if (!additional) return [primary];
  const successors = additional.split(',').map((pin) => pin.trim().toLowerCase());
  if (successors.some((pin) => !fingerprintPattern.test(pin)))
    throw new Error('ARIA_WINDOWS_ADDITIONAL_SIGNERS_SHA256 must contain comma-separated 64-character SHA-256 fingerprints in hex without separators.');
  return [primary, ...successors];
}
