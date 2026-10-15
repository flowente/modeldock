import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { connect, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { LinkError } from "./errors.ts";
import type { ServerIdentity } from "./identity.ts";
import type { LinkTarget } from "./link.ts";
import type { DeviceSummary, LinkRegistry } from "./registry.ts";

/** Header con cui il dispositivo si presenta. Non è `Authorization`: quello resta all'app dietro. */
export const TOKEN_HEADER = "x-modeldock-link-token";
export const API_PREFIX = "/_link/v1/";
/** Un dispositivo attivo negli ultimi 5 minuti è "online". */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

const MAX_JOIN_BODY_BYTES = 8 * 1024;
const JOIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_JOINS_PER_WINDOW = 20;
const SEEN_WRITE_INTERVAL_MS = 30 * 1000;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export interface LinkServerOptions {
  identity: ServerIdentity;
  registry: LinkRegistry;
  /** Dove gira il servizio da raggiungere: l'API di ModelDock, che serve anche l'interfaccia. */
  upstream: LinkTarget;
  listen?: { host?: string; port?: number };
  /**
   * Lascia passare le richieste senza credenziale di dispositivo (il browser di un telefono
   * sulla stessa rete), protette solo dal login dell'app dietro. Una credenziale presente ma
   * sbagliata viene comunque rifiutata. Soluzione di passaggio finché non c'è l'app per telefono.
   */
  allowUnpairedBrowsers?: boolean;
  now?: () => number;
}

export interface RunningLinkServer {
  host: string;
  port: number;
  /** Ultima attività vista per dispositivo, in millisecondi. Serve a dire chi è "online". */
  lastActivity: ReadonlyMap<string, number>;
  close(): Promise<void>;
}

export async function startLinkServer(options: LinkServerOptions): Promise<RunningLinkServer> {
  const now = options.now ?? Date.now;
  const lastActivity = new Map<string, number>();
  const lastSeenWrite = new Map<string, number>();
  const joinAttempts = new Map<string, number[]>();
  // I WebSocket escono dal controllo del server HTTP: vanno chiusi a mano allo spegnimento.
  const tunnels = new Set<Duplex>();

  const recordActivity = (device: DeviceSummary) => {
    const time = now();
    lastActivity.set(device.id, time);
    if (time - (lastSeenWrite.get(device.id) ?? 0) >= SEEN_WRITE_INTERVAL_MS) {
      lastSeenWrite.set(device.id, time);
      void options.registry.markSeen(device.id).catch(() => undefined);
    }
  };

  const authorize = async (headers: IncomingHttpHeaders): Promise<{ device?: DeviceSummary; browser?: true; status: number; error?: string }> => {
    const raw = headers[TOKEN_HEADER];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!token) return options.allowUnpairedBrowsers ? { browser: true, status: 200 } : { status: 401, error: "device_token_missing" };
    const device = await options.registry.authenticate(token);
    if (!device) return { status: 401, error: "device_unknown" };
    if (!device.authorized) return { status: 403, error: "device_pending" };
    recordActivity(device);
    return { device, status: 200 };
  };

  const allowJoin = (address: string): boolean => {
    const time = now();
    const recent = (joinAttempts.get(address) ?? []).filter((at) => time - at < JOIN_WINDOW_MS);
    recent.push(time);
    joinAttempts.set(address, recent);
    return recent.length <= MAX_JOINS_PER_WINDOW;
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    if (path === "join" && req.method === "POST") {
      if (!allowJoin(req.socket.remoteAddress ?? "unknown")) {
        throw new LinkError("rate_limited", "Troppi tentativi. Riprova fra qualche minuto.");
      }
      const body = await readJson(req);
      const result = await options.registry.redeemInvite({
        inviteId: stringField(body, "inviteId"),
        secret: stringField(body, "secret"),
        hostname: stringField(body, "hostname"),
        ...optionalString(body, "pin"),
        ...optionalString(body, "os")
      });
      return sendJson(res, 201, { deviceId: result.device.id, token: result.token, authorized: result.device.authorized });
    }
    if (path === "me" && req.method === "GET") {
      const raw = req.headers[TOKEN_HEADER];
      const device = typeof raw === "string" ? await options.registry.authenticate(raw) : undefined;
      if (!device) return sendJson(res, 401, { error: "device_unknown" });
      if (device.authorized) recordActivity(device);
      return sendJson(res, 200, { deviceId: device.id, hostname: device.hostname, authorized: device.authorized });
    }
    return sendJson(res, 404, { error: "not_found" });
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (url.startsWith(API_PREFIX)) return handleApi(req, res, url.slice(API_PREFIX.length).split("?")[0] ?? "");
    if (url === "/join" || url.startsWith("/join?")) return sendJoinPage(res);

    const auth = await authorize(req.headers);
    if (!auth.device && !auth.browser) return sendJson(res, auth.status, { error: auth.error });

    const upstreamRequest = http.request({
      host: options.upstream.host,
      port: options.upstream.port,
      method: req.method,
      path: url,
      headers: forwardHeaders(req)
    });
    upstreamRequest.on("response", (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, stripHopByHop(upstreamResponse.headers));
      upstreamResponse.pipe(res);
    });
    upstreamRequest.on("error", () => {
      if (!res.headersSent) sendJson(res, 502, { error: "upstream_unreachable" });
      else res.destroy();
    });
    req.pipe(upstreamRequest);
  };

  const handleUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const auth = await authorize(req.headers);
    if (!auth.device && !auth.browser) return rejectUpgrade(socket, auth.status);
    const upstream = connect(options.upstream.port, options.upstream.host);
    const failBeforeConnect = () => rejectUpgrade(socket, 502);
    upstream.once("error", failBeforeConnect);
    upstream.once("connect", () => {
      upstream.off("error", failBeforeConnect);
      upstream.write(serializeRequestHead(req, forwardHeaders(req, true)));
      if (head.length > 0) upstream.write(head);
      joinSockets(socket, upstream, tunnels);
    });
  };

  const server = https.createServer({ key: options.identity.keyPem, cert: options.identity.certPem, minVersion: "TLSv1.2" });
  server.on("request", (req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.destroy();
      if (error instanceof LinkError) return sendJson(res, error.httpStatus, { error: error.code, message: error.message });
      sendJson(res, 500, { error: "internal_error" });
    });
  });
  server.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket, head).catch(() => rejectUpgrade(socket, 500));
  });

  const listenHost = options.listen?.host ?? "0.0.0.0";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listen?.port ?? 0, listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    host: listenHost,
    port: address.port,
    lastActivity,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of tunnels) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

function forwardHeaders(req: IncomingMessage, keepUpgrade = false): Record<string, string | string[]> {
  const headers = keepUpgrade ? { ...req.headers } : stripHopByHop(req.headers);
  delete headers[TOKEN_HEADER];
  const forwardedFor = req.socket.remoteAddress;
  if (forwardedFor) headers["x-forwarded-for"] = forwardedFor;
  headers["x-forwarded-proto"] = "https";
  return headers as Record<string, string | string[]>;
}

function stripHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) result[name] = value;
  }
  return result;
}

/**
 * Collega due connessioni nei due sensi. Quando una si chiude o va in errore si chiude anche
 * l'altra: un WebSocket abbandonato da un lato non resta appeso dall'altro.
 */
export function joinSockets(a: Duplex, b: Duplex, tracked?: Set<Duplex>): void {
  tracked?.add(a);
  tracked?.add(b);
  const closeBoth = () => {
    a.destroy();
    b.destroy();
    tracked?.delete(a);
    tracked?.delete(b);
  };
  a.pipe(b).pipe(a);
  for (const socket of [a, b]) {
    // I socket dei server HTTP restano mezzi aperti dopo la fine: "end" va trattato come chiusura.
    socket.once("end", closeBoth);
    socket.once("close", closeBoth);
    socket.once("error", closeBoth);
  }
}

export function serializeRequestHead(req: IncomingMessage, headers: Record<string, string | string[] | undefined>): string {
  const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function rejectUpgrade(socket: Duplex, status: number): void {
  if (!socket.writable) return;
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_JOIN_BODY_BYTES) throw new LinkError("bad_request", "Richiesta troppo grande.");
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // ricade nell'errore qui sotto
  }
  throw new LinkError("bad_request", "La richiesta deve essere un oggetto JSON.");
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new LinkError("bad_request", `Campo mancante o non valido: ${name}.`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, name: string): Record<string, string> {
  return body[name] === undefined ? {} : { [name]: stringField(body, name) };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  res.end(payload);
}

/** La pagina che vede chi apre il link nel browser. Il segreto resta nel `#` e non arriva mai qui. */
function sendJoinPage(res: ServerResponse): void {
  const html = `<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invito ModelDock</title><body style="font-family:Georgia,serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1>Invito ModelDock</h1><p>Questo è un invito a collegarti a un server ModelDock.</p>
<p>Per entrare, apri il link con ModelDock Link su questo dispositivo.</p></body></html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end(html);
}

