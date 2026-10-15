import http, { type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { joinWithLink, pinnedRequest, startLocalProxy, fetchDeviceStatus, type LocalProxy } from "./client.ts";
import { createIdentity, type ServerIdentity } from "./identity.ts";
import { buildInviteLink } from "./link.ts";
import { LinkRegistry } from "./registry.ts";
import { startLinkServer, TOKEN_HEADER, type RunningLinkServer } from "./server.ts";
import { MemoryStateStore } from "./store.ts";

/** Una finta app dietro la connessione: restituisce gli header ricevuti e fa da eco sui WebSocket. */
function startFakeUpstream(): Promise<{ server: Server; sockets: Set<Duplex> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, headers: req.headers }));
  });
  const sockets = new Set<Duplex>();
  server.on("upgrade", (_req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (data) => socket.write(data));
    socket.on("end", () => socket.end());
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, sockets })));
}

describe("dal link al modello, end to end", () => {
  let identity: ServerIdentity;
  let registry: LinkRegistry;
  let upstream: Server;
  let upstreamSockets: Set<Duplex>;
  let server: RunningLinkServer;
  const proxies: LocalProxy[] = [];

  const hosts = () => [{ host: "127.0.0.1", port: server.port }];
  const newLink = async (options = {}) => {
    const created = await registry.createInvite(options);
    return buildInviteLink({ hosts: hosts(), inviteId: created.invite.id, secret: created.secret, fingerprint: identity.fingerprint });
  };

  beforeAll(async () => {
    identity = await createIdentity();
    registry = new LinkRegistry(new MemoryStateStore());
    ({ server: upstream, sockets: upstreamSockets } = await startFakeUpstream());
    const upstreamPort = (upstream.address() as AddressInfo).port;
    server = await startLinkServer({ identity, registry, upstream: { host: "127.0.0.1", port: upstreamPort }, listen: { host: "127.0.0.1", port: 0 } });
  }, 30_000);

  afterAll(async () => {
    await Promise.all(proxies.map((proxy) => proxy.close()));
    await server.close();
    await new Promise((resolve) => upstream.close(resolve));
  });

  it("un dispositivo in attesa non arriva al modello; dopo l'approvazione sì, e senza il suo token", async () => {
    const { credentials, authorized } = await joinWithLink(await newLink(), { hostname: "portatile" });
    expect(authorized).toBe(false);
    expect(await fetchDeviceStatus(credentials)).toEqual({ authorized: false, hostname: "portatile" });

    const proxy = await startLocalProxy(credentials);
    proxies.push(proxy);
    const pending = await fetch(`${proxy.url}/api/models`);
    expect(pending.status).toBe(403);

    await registry.setAuthorization(credentials.deviceId, true);
    const approved = await fetch(`${proxy.url}/api/models?x=1`, { headers: { authorization: "Bearer chiave-dell-app" } });
    expect(approved.status).toBe(200);
    const echoed = (await approved.json()) as { path: string; headers: Record<string, string> };
    expect(echoed.path).toBe("/api/models?x=1");
    // Il token di ModelDock Link si ferma al server; l'Authorization dell'app passa intatta.
    expect(echoed.headers[TOKEN_HEADER]).toBeUndefined();
    expect(echoed.headers.authorization).toBe("Bearer chiave-dell-app");
  });

  it("i WebSocket (la chat in streaming) passano dopo l'approvazione", async () => {
    const { credentials } = await joinWithLink(await newLink({ preauthorized: true }), { hostname: "desktop" });
    const proxy = await startLocalProxy(credentials);
    proxies.push(proxy);

    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(proxy.port, "127.0.0.1", () => {
        socket.write("GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      });
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        if (buffer.includes("101 Switching Protocols") && !buffer.includes("ciao")) socket.write("ciao");
        if (buffer.includes("ciao")) {
          socket.destroy();
          resolve(buffer);
        }
      });
      socket.on("error", reject);
    });
    expect(reply).toContain("101 Switching Protocols");
    expect(reply).toContain("ciao");
    // Chiuso dal dispositivo, il WebSocket si chiude anche verso l'app: niente connessioni appese.
    await expect.poll(() => upstreamSockets.size, { timeout: 2000 }).toBe(0);
  });

  it("senza token, o con un token inventato, non si passa", async () => {
    const base = { target: hosts()[0]!, fingerprint: identity.fingerprint, method: "GET", path: "/api/models" };
    expect((await pinnedRequest(base)).status).toBe(401);
    expect((await pinnedRequest({ ...base, headers: { [TOKEN_HEADER]: "mdl_inventato" } })).status).toBe(401);
  });

  it("se il server non ha il certificato dell'invito, il dispositivo si ferma prima di mandare il segreto", async () => {
    const impostor = await createIdentity();
    const created = await registry.createInvite();
    const link = buildInviteLink({ hosts: hosts(), inviteId: created.invite.id, secret: created.secret, fingerprint: impostor.fingerprint });

    await expect(joinWithLink(link)).rejects.toMatchObject({ code: "fingerprint_mismatch" });
    const invite = (await registry.listInvites()).find((candidate) => candidate.id === created.invite.id);
    expect(invite?.uses).toBe(0);
  });

  it("prova gli indirizzi in ordine e salta quelli irraggiungibili", async () => {
    const created = await registry.createInvite();
    const link = buildInviteLink({
      hosts: [{ host: "127.0.0.1", port: 1 }, ...hosts()],
      inviteId: created.invite.id,
      secret: created.secret,
      fingerprint: identity.fingerprint
    });
    const { credentials } = await joinWithLink(link);
    expect(credentials.hosts[0]).toEqual(hosts()[0]);
  });

  it("con allowUnpairedBrowsers passa chi non ha credenziale, ma non chi ne ha una falsa", async () => {
    const open = await startLinkServer({
      identity,
      registry,
      upstream: { host: "127.0.0.1", port: (upstream.address() as AddressInfo).port },
      listen: { host: "127.0.0.1", port: 0 },
      allowUnpairedBrowsers: true
    });
    try {
      const target = { host: "127.0.0.1", port: open.port };
      expect((await pinnedRequest({ target, fingerprint: identity.fingerprint, method: "GET", path: "/" })).status).toBe(200);
      const forged = await pinnedRequest({ target, fingerprint: identity.fingerprint, method: "GET", path: "/", headers: { [TOKEN_HEADER]: "mdl_inventato" } });
      expect(forged.status).toBe(401);
    } finally {
      await open.close();
    }
  });

  it("il link aperto nel browser mostra una pagina e non consuma l'invito", async () => {
    const created = await registry.createInvite();
    const response = await pinnedRequest({ target: hosts()[0]!, fingerprint: identity.fingerprint, method: "GET", path: "/join" });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toContain("Invito ModelDock");
    const invite = (await registry.listInvites()).find((candidate) => candidate.id === created.invite.id);
    expect(invite?.uses).toBe(0);
  });
});
