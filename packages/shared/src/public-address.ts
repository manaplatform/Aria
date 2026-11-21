import ipaddr from 'ipaddr.js';

export function publicAddress(value: string): boolean {
  if (value.includes('%')) return false;
  try {
    const address = ipaddr.process(value);
    if (address.range() !== 'unicast') return false;
    if (address.kind() === 'ipv4') return true;
    const v6 = address as ipaddr.IPv6;
    return (
      v6.match(ipaddr.IPv6.parse('2000::'), 3) &&
      !v6.match(ipaddr.IPv6.parse('2001::'), 23) &&
      !v6.match(ipaddr.IPv6.parse('3fff::'), 20)
    );
  } catch {
    return false;
  }
}

export async function resolvePublicAddress<T extends { address: string; family: number }>(
  hostname: string,
  lookup: (hostname: string) => Promise<T[]>,
): Promise<T> {
  const answers = await lookup(hostname.replace(/^\[|\]$/g, ''));
  if (!answers.length || answers.some(({ address }) => !publicAddress(address)))
    throw new Error('Local and private destinations are blocked.');
  return answers[0];
}
