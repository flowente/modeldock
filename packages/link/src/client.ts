import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { hostname as osHostname, platform } from "node:os";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import tls, { type TLSSocket } from "node:tls";
import { LinkError } from "./errors.ts";
import { normalizeFingerprint } from "./identity.ts";
import { formatTarget, parseInviteLink, type LinkTarget } from "./link.ts";
import { API_PREFIX, joinSockets, serializeRequestHead, TOKEN_HEADER } from "./server.ts";

/** Ciò che il dispositivo conserva dopo essere entrato. Il token è una credenziale: non va mai stampato. */
export interface DeviceCredentials {
  version: 1;
  deviceId: string;
  token: string;
  fingerprint: string;
  hosts: LinkTarget[];
}

const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Apre una connessione TLS e la consegna solo se il server mostra il certificato atteso.
 * Nessun byte dell'applicazione parte prima del controllo dell'impronta.
 */
export function connectPinned(target: LinkTarget, fingerprint: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<TLSSocket> {
  const expected = Buffer.from(normalizeFingerprint(fingerprint), "hex");
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      // La fiducia non viene da un'autorità: viene dall'impronta ricevuta con l'invito.
      rejectUnauthorized: false,
      ...(isIP(target.host) ? {} : { servername: target.host }),
      minVersion: "TLSv1.2"
    });
    const timer = setTimeout(() => fail(new LinkError("unreachable", `Nessuna risposta da ${formatTarget(target)}.`)), timeoutMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("error", (error) => fail(new LinkError("unreachable", `Impossibile raggiungere ${formatTarget(target)}: ${error.message}`)));
    socket.once("secureConnect", () => {
      const presented = Buffer.from(normalizeFingerprint(socket.getPeerCertificate().fingerprint256 ?? ""), "hex");
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        return fail(new LinkError("fingerprint_mismatch", "Il server non è quello dell'invito. Connessione interrotta."));
      }
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
  });
}

export interface PinnedResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export async function pinnedRequest(input: {
  target: LinkTarget;
  fingerprint: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<PinnedResponse> {
  const socket = await connectPinned(input.target, input.fingerprint);
  return new Promise((resolve, reject) => {
    const request = http.request({
      method: input.method,
      path: input.path,
      headers: { host: formatTarget(input.target), ...input.headers },
      createConnection: () => socket
    });
    request.on("response", async (response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of response as AsyncIterable<Buffer>) chunks.push(chunk);
      socket.end();
      resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
    });
    request.on("error", reject);
    request.end(input.body);
  });
}

/** Prova gli indirizzi dell'invito in ordine e restituisce il primo che risponde con il certificato giusto. */
async function firstReachable<T>(hosts: LinkTarget[], attempt: (target: LinkTarget) => Promise<T>): Promise<{ target: LinkTarget; result: T }> {
  const failures: string[] = [];
  for (const target of hosts) {
    try {
      return { target, result: await attempt(target) };
    } catch (error) {
      // Un certificato sbagliato non è un indirizzo irraggiungibile: ci si ferma subito.
      if (error instanceof LinkError && error.code === "fingerprint_mismatch") throw error;
      if (!(error instanceof LinkError && error.code === "unreachable")) throw error;
      failures.push(error.message);
    }
  }
  throw new LinkError("unreachable", `Server ModelDock non raggiungibile.\n${failures.join("\n")}`);
}

export interface JoinOptions {
  hostname?: string;
  os?: string;
  pin?: string;
}

export interface JoinResult {
  credentials: DeviceCredentials;
  authorized: boolean;
}

export async function joinWithLink(linkText: string, options: JoinOptions = {}): Promise<JoinResult> {
  const link = parseInviteLink(linkText);
  const body = JSON.stringify({
    inviteId: link.inviteId,
    secret: link.secret,
    hostname: options.hostname ?? osHostname(),
    os: options.os ?? platform(),
    ...(options.pin ? { pin: options.pin } : {})
  });
  const { target, result } = await firstReachable(link.hosts, (candidate) =>
    pinnedRequest({
      target: candidate,
      fingerprint: link.fingerprint,
      method: "POST",
      path: `${API_PREFIX}join`,
      headers: { "content-type": "application/json" },
      body
    })
  );
  const payload = parseJsonBody(result.body);
  if (result.status !== 201) {
    throw new LinkError(isLinkErrorCode(payload.error) ? payload.error : "bad_request", String(payload.message ?? "Invito rifiutato dal server."));
  }
  // L'indirizzo che ha funzionato va per primo: è quello da provare la prossima volta.
  const hosts = [target, ...link.hosts.filter((candidate) => formatTarget(candidate) !== formatTarget(target))];
  return {
    credentials: { version: 1, deviceId: String(payload.deviceId), token: String(payload.token), fingerprint: link.fingerprint, hosts },
    authorized: payload.authorized === true
  };
}

export async function fetchDeviceStatus(credentials: DeviceCredentials): Promise<{ authorized: boolean; hostname: string }> {
  const { result } = await firstReachable(credentials.hosts, (target) =>
    pinnedRequest({ target, fingerprint: credentials.fingerprint, method: "GET", path: `${API_PREFIX}me`, headers: { [TOKEN_HEADER]: credentials.token } })
  );
  const payload = parseJsonBody(result.body);
  if (result.status !== 200) throw new LinkError("device_not_found", "Questo dispositivo non è più registrato sul server.");
  return { authorized: payload.authorized === true, hostname: String(payload.hostname) };
}

export interface LocalProxy {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Un indirizzo locale (http://127.0.0.1:porta) che porta al server ModelDock.
 * Il browser del computer parla con il proxy in locale; il proxy aggiunge la credenziale
 * e attraversa la rete solo dentro la connessione TLS verificata.
 * Ascolta solo su 127.0.0.1: dalla rete non è raggiungibile.
 */
export async function startLocalProxy(credentials: DeviceCredentials, port = 0): Promise<LocalProxy> {
  let preferred = credentials.hosts;
  const tunnels = new Set<Duplex>();
  const open = async () => {
    const { target, result } = await firstReachable(preferred, (candidate) => connectPinned(candidate, credentials.fingerprint));
    preferred = [target, ...credentials.hosts.filter((candidate) => formatTarget(candidate) !== formatTarget(target))];
    return result;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const socket = await open();
      const upstream = http.request({
        method: req.method,
        path: req.url,
        headers: { ...withoutToken(req), [TOKEN_HEADER]: credentials.token },
        createConnection: () => socket
      });
      upstream.on("response", (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
      req.pipe(upstream);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Errore di connessione.";
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end(message);
    }
  });

  server.on("upgrade", async (req: IncomingMessage, client: Duplex, head: Buffer) => {
    try {
      const socket = await open();
      socket.write(serializeRequestHead(req, { ...withoutToken(req), [TOKEN_HEADER]: credentials.token }));
      if (head.length > 0) socket.write(head);
      joinSockets(client, socket, tunnels);
    } catch {
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of tunnels) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

export async function saveCredentials(path: string, credentials: DeviceCredentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

export async function loadCredentials(path: string): Promise<DeviceCredentials> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as DeviceCredentials;
  if (parsed.version !== 1) throw new Error("Credenziali in un formato non supportato.");
  return parsed;
}

function withoutToken(req: IncomingMessage): Record<string, string | string[]> {
  const headers = { ...req.headers } as Record<string, string | string[] | undefined>;
  delete headers[TOKEN_HEADER];
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined));
}

function parseJsonBody(body: Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isLinkErrorCode(value: unknown): value is LinkError["code"] {
  return typeof value === "string" && /^[a-z_]+$/.test(value);
}
