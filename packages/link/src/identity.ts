import "reflect-metadata";
import { X509Certificate as NodeX509Certificate, webcrypto } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as x509 from "@peculiar/x509";

/**
 * L'identità del server: una chiave privata e un certificato autofirmato.
 * Nessuna autorità esterna lo firma. I dispositivi lo riconoscono dall'impronta
 * (SHA-256 del certificato) ricevuta con l'invito, non da una catena di fiducia.
 */
export interface ServerIdentity {
  keyPem: string;
  certPem: string;
  /** SHA-256 del certificato in esadecimale minuscolo, senza separatori. */
  fingerprint: string;
}

const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export async function createIdentity(commonName = "ModelDock"): Promise<ServerIdentity> {
  const crypto = webcrypto as unknown as Crypto;
  const keys = await crypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"]);
  const now = Date.now();
  const certificate = await x509.X509CertificateGenerator.createSelfSigned(
    {
      name: `CN=${commonName}`,
      keys,
      signingAlgorithm: KEY_ALGORITHM,
      notBefore: new Date(now - 60_000),
      notAfter: new Date(now + TEN_YEARS_MS),
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth])
      ]
    },
    crypto
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  const keyPem = x509.PemConverter.encode(pkcs8, "PRIVATE KEY");
  const certPem = certificate.toString("pem");
  return { keyPem, certPem, fingerprint: fingerprintOfCertificate(certPem) };
}

export function fingerprintOfCertificate(certPem: string): string {
  return normalizeFingerprint(new NodeX509Certificate(certPem).fingerprint256);
}

/** Accetta sia "AA:BB:…" (formato di Node) sia "aabb…". */
export function normalizeFingerprint(value: string): string {
  return value.replace(/:/g, "").toLowerCase();
}

/** Carica l'identità da `dir`, o la crea al primo avvio. La chiave non lascia mai la cartella. */
export async function loadOrCreateIdentity(dir: string): Promise<ServerIdentity> {
  const keyPath = join(dir, "server-key.pem");
  const certPath = join(dir, "server-cert.pem");
  try {
    const [keyPem, certPem] = await Promise.all([readFile(keyPath, "utf8"), readFile(certPath, "utf8")]);
    return { keyPem, certPem, fingerprint: fingerprintOfCertificate(certPem) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const identity = await createIdentity();
  await mkdir(dir, { recursive: true });
  await writeFile(keyPath, identity.keyPem, { mode: 0o600 });
  await writeFile(certPath, identity.certPem);
  return identity;
}
