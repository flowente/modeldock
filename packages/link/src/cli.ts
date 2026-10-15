#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fetchDeviceStatus, joinWithLink, loadCredentials, saveCredentials, startLocalProxy } from "./client.ts";
import { LinkError } from "./errors.ts";
import { loadOrCreateIdentity } from "./identity.ts";
import { listLanAddresses } from "./lan.ts";
import { buildInviteLink, type LinkTarget } from "./link.ts";
import { LinkRegistry } from "./registry.ts";
import { startLinkServer } from "./server.ts";
import { FileStateStore } from "./store.ts";

const DEFAULT_PORT = 4319;
const DEFAULT_PROXY_PORT = 4320;
const DEFAULT_UPSTREAM = "127.0.0.1:8080";

const USAGE = `ModelDock Link — connessione diretta fra dispositivi e un server ModelDock.

Sul computer che fa da server:
  serve    [--port 4319] [--upstream 127.0.0.1:8080]   avvia il server
  invite   [--with-pin] [--reusable] [--preauthorized] [--hours 24] [--host IP]
                                                      crea un invito e stampa il link
  devices                                             elenca i dispositivi
  approve  <id>                                       approva un dispositivo
  block    <id>                                       blocca un dispositivo
  remove   <id>                                       cancella un dispositivo

Sul dispositivo che si collega:
  join     <link> [--pin 123456] [--name nome]        entra con un invito
  status                                              mostra se il dispositivo è approvato
  proxy    [--port 4320]                              apre http://127.0.0.1:4320 verso il server

Opzioni comuni: --data <cartella> (default ~/.modeldock-link)`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      data: { type: "string" },
      port: { type: "string" },
      upstream: { type: "string" },
      host: { type: "string", multiple: true },
      hours: { type: "string" },
      pin: { type: "string" },
      "with-pin": { type: "boolean" },
      name: { type: "string" },
      reusable: { type: "boolean" },
      preauthorized: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    }
  });
  const [command, argument] = positionals;
  const dataDir = values.data ?? join(homedir(), ".modeldock-link");
  const serverDir = join(dataDir, "server");
  const credentialsPath = join(dataDir, "device.json");
  const registry = () => new LinkRegistry(new FileStateStore(join(serverDir, "state.json")));

  if (!command || values.help) return console.log(USAGE);

  switch (command) {
    case "serve": {
      const identity = await loadOrCreateIdentity(serverDir);
      const port = parsePort(values.port, DEFAULT_PORT);
      const upstream = parseTarget(values.upstream ?? DEFAULT_UPSTREAM);
      const server = await startLinkServer({ identity, registry: registry(), upstream, listen: { port } });
      console.log(`Server avviato sulla porta ${server.port}, inoltra a ${upstream.host}:${upstream.port}.`);
      console.log(`Impronta del certificato: ${identity.fingerprint}`);
      const addresses = listLanAddresses();
      console.log(addresses.length ? `Raggiungibile in rete locale su: ${addresses.join(", ")}` : "Attenzione: nessuna rete locale trovata.");
      const stop = async () => {
        await server.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }

    case "invite": {
      const identity = await loadOrCreateIdentity(serverDir);
      const port = parsePort(values.port, DEFAULT_PORT);
      const hosts: LinkTarget[] = (values.host?.length ? values.host : listLanAddresses()).map((host) => ({ host, port }));
      if (hosts.length === 0) throw new Error("Nessun indirizzo di rete locale: collega il computer a una rete o indica --host.");
      const hours = values.hours ? Number(values.hours) : 24;
      const created = await registry().createInvite({
        ttlSeconds: Math.round(hours * 3600),
        reusable: values.reusable ?? false,
        preauthorized: values.preauthorized ?? false,
        requirePin: values["with-pin"] ?? false
      });
      console.log(buildInviteLink({ hosts, inviteId: created.invite.id, secret: created.secret, fingerprint: identity.fingerprint }));
      console.log(`\nScade: ${created.invite.expiresAt}${created.invite.reusable ? " · riutilizzabile" : " · valido una volta"}`);
      if (created.pin) console.log(`Codice da comunicare a voce o per un'altra strada: ${created.pin}`);
      return;
    }

    case "devices": {
      const devices = await registry().listDevices();
      if (devices.length === 0) return console.log("Nessun dispositivo.");
      for (const device of devices) {
        const state = device.authorized ? "approvato " : "in attesa ";
        console.log(`${device.id}  ${state}  ${device.hostname}${device.os ? ` (${device.os})` : ""}  visto: ${device.lastSeen ?? "mai"}`);
      }
      return;
    }

    case "approve":
    case "block": {
      const device = await registry().setAuthorization(required(argument, "id del dispositivo"), command === "approve");
      return console.log(`${device.hostname}: ${device.authorized ? "approvato" : "bloccato"}.`);
    }

    case "remove": {
      await registry().removeDevice(required(argument, "id del dispositivo"));
      return console.log("Dispositivo cancellato.");
    }

    case "join": {
      const result = await joinWithLink(required(argument, "link di invito"), {
        ...(values.name ? { hostname: values.name } : {}),
        ...(values.pin ? { pin: values.pin } : {})
      });
      await saveCredentials(credentialsPath, result.credentials);
      console.log(
        result.authorized
          ? "Collegato e già approvato. Avvia `proxy` per aprire ModelDock."
          : "Collegato. In attesa che il server approvi questo dispositivo."
      );
      return;
    }

    case "status": {
      const status = await fetchDeviceStatus(await loadCredentials(credentialsPath));
      return console.log(`${status.hostname}: ${status.authorized ? "approvato" : "in attesa di approvazione"}.`);
    }

    case "proxy": {
      const proxy = await startLocalProxy(await loadCredentials(credentialsPath), parsePort(values.port, DEFAULT_PROXY_PORT));
      console.log(`Apri ${proxy.url} nel browser. Ctrl+C per chiudere.`);
      return;
    }

    default:
      throw new Error(`Comando sconosciuto: ${command}\n\n${USAGE}`);
  }
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Porta non valida: ${value}`);
  return port;
}

function parseTarget(value: string): LinkTarget {
  const index = value.lastIndexOf(":");
  return { host: value.slice(0, index), port: parsePort(value.slice(index + 1), 0) };
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Manca ${label}.`);
  return value;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof LinkError || error instanceof Error ? error.message : String(error));
  process.exit(1);
});
