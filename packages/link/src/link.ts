import { isIPv6 } from "node:net";
import { LinkError } from "./errors.ts";
import { normalizeFingerprint } from "./identity.ts";

export interface LinkTarget {
  host: string;
  port: number;
}

/**
 * Tutto quello che serve per entrare: dove trovare il server, quale invito usare,
 * il segreto e l'impronta del certificato con cui riconoscere il server.
 */
export interface InviteLink {
  hosts: LinkTarget[];
  inviteId: string;
  secret: string;
  fingerprint: string;
}

/**
 * I dati sensibili stanno dopo il `#`. Quella parte non viene mai inviata ai server:
 * le anteprime di WhatsApp, Slack o dei filtri antivirus possono aprire la pagina
 * senza consumare l'invito e senza vedere il segreto.
 */
export function buildInviteLink(invite: InviteLink): string {
  const [primary] = invite.hosts;
  if (!primary) throw new LinkError("bad_request", "Serve almeno un indirizzo del server.");
  const fragment = new URLSearchParams({
    v: "1",
    i: invite.inviteId,
    s: invite.secret,
    fp: invite.fingerprint,
    h: invite.hosts.map(formatTarget).join(",")
  });
  return `https://${formatTarget(primary)}/join#${fragment.toString()}`;
}

export function parseInviteLink(text: string): InviteLink {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new LinkError("bad_request", "Questo non sembra un link di invito ModelDock.");
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  if (fragment.get("v") !== "1") throw new LinkError("bad_request", "Versione dell'invito non supportata.");
  const inviteId = fragment.get("i") ?? "";
  const secret = fragment.get("s") ?? "";
  const fingerprint = normalizeFingerprint(fragment.get("fp") ?? "");
  if (!/^inv_[0-9a-f]{16}$/.test(inviteId) || !secret || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new LinkError("bad_request", "Il link di invito è incompleto.");
  }
  const listed = (fragment.get("h") ?? "").split(",").filter(Boolean).map(parseTarget);
  const fromUrl = parseTarget(url.host);
  const hosts = listed.length > 0 ? listed : [fromUrl];
  return { hosts, inviteId, secret, fingerprint };
}

export function formatTarget(target: LinkTarget): string {
  const host = isIPv6(target.host) ? `[${target.host}]` : target.host;
  return `${host}:${target.port}`;
}

function parseTarget(value: string): LinkTarget {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(value);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LinkError("bad_request", `Indirizzo non valido nel link: ${value}`);
  }
  return { host, port };
}
