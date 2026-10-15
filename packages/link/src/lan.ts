import { networkInterfaces } from "node:os";

/**
 * Gli indirizzi della rete di casa (IPv4 privati) su cui il server è raggiungibile.
 * Esclude loopback e indirizzi autoconfigurati (169.254.x.x), che non portano a nessuno.
 */
export function listLanAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (isPrivateIPv4(entry.address)) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

export function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a, b] = parts;
  if (parts.length !== 4 || a === undefined || b === undefined) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
