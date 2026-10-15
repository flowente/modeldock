import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { LinkError } from "./errors.ts";
import type { LinkState, StateStore, StoredDevice, StoredInvite } from "./store.ts";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const DEFAULT_INVITE_TTL_SECONDS = 24 * 60 * 60;
/** Dopo questi tentativi di PIN sbagliati l'invito non vale più. */
export const MAX_PIN_ATTEMPTS = 5;

export interface CreateInviteOptions {
  ttlSeconds?: number;
  reusable?: boolean;
  /** Il dispositivo entra già approvato. Di default no: lo approva chi gestisce il server. */
  preauthorized?: boolean;
  ephemeral?: boolean;
  /** Un codice di 6 cifre da comunicare per un'altra strada: il link da solo non basta. */
  requirePin?: boolean;
  tags?: string[];
  description?: string;
  email?: string;
}

export interface CreatedInvite {
  invite: InviteSummary;
  /** Va nel link e non viene salvato da nessuna parte: si vede una volta sola. */
  secret: string;
  pin?: string;
}

export interface InviteSummary {
  id: string;
  createdAt: string;
  expiresAt: string;
  reusable: boolean;
  preauthorized: boolean;
  ephemeral: boolean;
  requiresPin: boolean;
  tags: string[];
  uses: number;
  revoked: boolean;
  description?: string;
  email?: string;
}

export interface RedeemInviteInput {
  inviteId: string;
  secret: string;
  pin?: string;
  hostname: string;
  os?: string;
}

export interface RedeemedInvite {
  device: DeviceSummary;
  /** Credenziale del dispositivo. Il server ne tiene solo l'hash. */
  token: string;
}

export interface DeviceSummary {
  id: string;
  hostname: string;
  os?: string;
  authorized: boolean;
  ephemeral: boolean;
  createdAt: string;
  lastSeen?: string;
}

export class LinkRegistry {
  private readonly store: StateStore;
  private readonly clock: Clock;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(store: StateStore, clock: Clock = systemClock) {
    this.store = store;
    this.clock = clock;
  }

  public async createInvite(options: CreateInviteOptions = {}): Promise<CreatedInvite> {
    return this.mutate(async (state) => {
      const now = this.clock.now();
      const ttlSeconds = options.ttlSeconds ?? DEFAULT_INVITE_TTL_SECONDS;
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        throw new LinkError("bad_request", "La durata dell'invito deve essere positiva.");
      }
      const id = `inv_${randomBytes(8).toString("hex")}`;
      const secret = randomBytes(24).toString("base64url");
      const pin = options.requirePin ? String(randomInt(0, 1_000_000)).padStart(6, "0") : undefined;
      const invite: StoredInvite = {
        id,
        secretHash: sha256(secret),
        ...(pin ? { pinHash: sha256(`${id}:${pin}`) } : {}),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
        reusable: options.reusable ?? false,
        preauthorized: options.preauthorized ?? false,
        ephemeral: options.ephemeral ?? false,
        tags: options.tags ?? [],
        ...(options.description ? { description: options.description } : {}),
        ...(options.email ? { email: options.email } : {}),
        uses: 0,
        failedPinAttempts: 0,
        revoked: false
      };
      state.invites.push(invite);
      return { invite: summarizeInvite(invite), secret, ...(pin ? { pin } : {}) };
    });
  }

  public async redeemInvite(input: RedeemInviteInput): Promise<RedeemedInvite> {
    return this.mutate(async (state) => {
      const invite = state.invites.find((candidate) => candidate.id === input.inviteId);
      // Invito inesistente e segreto sbagliato danno la stessa risposta: non si indovina quale dei due.
      if (!invite || !hashesEqual(invite.secretHash, sha256(input.secret))) {
        throw new LinkError("invite_invalid", "Invito non valido.");
      }
      if (invite.revoked || invite.failedPinAttempts >= MAX_PIN_ATTEMPTS) {
        throw new LinkError("invite_locked", "Questo invito è stato bloccato. Chiedine uno nuovo.");
      }
      if (this.clock.now().getTime() >= Date.parse(invite.expiresAt)) {
        throw new LinkError("invite_expired", "Questo invito è scaduto. Chiedine uno nuovo.");
      }
      if (!invite.reusable && invite.uses > 0) {
        throw new LinkError("invite_used", "Questo invito è già stato usato. Chiedine uno nuovo.");
      }
      if (invite.pinHash) {
        if (!input.pin) throw new LinkError("pin_required", "Serve il codice mostrato sul computer.");
        if (!hashesEqual(invite.pinHash, sha256(`${invite.id}:${input.pin}`))) {
          invite.failedPinAttempts += 1;
          const left = MAX_PIN_ATTEMPTS - invite.failedPinAttempts;
          // Il tentativo fallito va salvato anche se l'operazione termina con un errore.
          throw new PersistingLinkError(
            "pin_invalid",
            left > 0 ? `Codice sbagliato. Tentativi rimasti: ${left}.` : "Codice sbagliato. L'invito è stato bloccato."
          );
        }
      }
      const hostname = cleanLabel(input.hostname, 64);
      if (!hostname) throw new LinkError("bad_request", "Il nome del dispositivo è obbligatorio.");
      const token = `mdl_${randomBytes(32).toString("base64url")}`;
      const now = this.clock.now().toISOString();
      const os = input.os ? cleanLabel(input.os, 32) : undefined;
      const device: StoredDevice = {
        id: `dev_${randomBytes(8).toString("hex")}`,
        hostname,
        ...(os ? { os } : {}),
        tokenHash: sha256(token),
        authorized: invite.preauthorized,
        ephemeral: invite.ephemeral,
        inviteId: invite.id,
        createdAt: now
      };
      invite.uses += 1;
      state.devices.push(device);
      return { device: summarizeDevice(device), token };
    });
  }

  /** Il dispositivo a cui appartiene il token, approvato o no. `undefined` se il token non esiste. */
  public async authenticate(token: string): Promise<DeviceSummary | undefined> {
    if (!token.startsWith("mdl_")) return undefined;
    const state = await this.read();
    const tokenHash = sha256(token);
    const device = state.devices.find((candidate) => hashesEqual(candidate.tokenHash, tokenHash));
    return device ? summarizeDevice(device) : undefined;
  }

  public async markSeen(deviceId: string): Promise<void> {
    await this.mutate(async (state) => {
      const device = state.devices.find((candidate) => candidate.id === deviceId);
      if (device) device.lastSeen = this.clock.now().toISOString();
    });
  }

  public async listDevices(): Promise<DeviceSummary[]> {
    return (await this.read()).devices.map(summarizeDevice);
  }

  public async listInvites(): Promise<InviteSummary[]> {
    return (await this.read()).invites.map(summarizeInvite);
  }

  public async setAuthorization(deviceId: string, authorized: boolean): Promise<DeviceSummary> {
    return this.mutate(async (state) => {
      const device = state.devices.find((candidate) => candidate.id === deviceId);
      if (!device) throw new LinkError("device_not_found", `Dispositivo ${deviceId} non trovato.`);
      device.authorized = authorized;
      return summarizeDevice(device);
    });
  }

  public async removeDevice(deviceId: string): Promise<void> {
    await this.mutate(async (state) => {
      const index = state.devices.findIndex((candidate) => candidate.id === deviceId);
      if (index === -1) throw new LinkError("device_not_found", `Dispositivo ${deviceId} non trovato.`);
      state.devices.splice(index, 1);
    });
  }

  public async revokeInvite(inviteId: string): Promise<void> {
    await this.mutate(async (state) => {
      const invite = state.invites.find((candidate) => candidate.id === inviteId);
      if (invite) invite.revoked = true;
    });
  }

  private async read() {
    await this.queue.catch(() => undefined);
    return this.store.load();
  }

  /** Le modifiche passano in fila una alla volta: niente scritture che si scavalcano. */
  private mutate<T>(operation: (state: LinkState) => Promise<T>): Promise<T> {
    const run = async () => {
      const state = await this.store.load();
      try {
        const result = await operation(state);
        await this.store.save(state);
        return result;
      } catch (error) {
        if (error instanceof PersistingLinkError) {
          await this.store.save(state);
          throw new LinkError(error.code, error.message);
        }
        throw error;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** Errore che non annulla le modifiche fatte prima di lanciarlo (es. il conteggio dei PIN sbagliati). */
class PersistingLinkError extends LinkError {}

function summarizeInvite(invite: StoredInvite): InviteSummary {
  return {
    id: invite.id,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    reusable: invite.reusable,
    preauthorized: invite.preauthorized,
    ephemeral: invite.ephemeral,
    requiresPin: Boolean(invite.pinHash),
    tags: [...invite.tags],
    uses: invite.uses,
    revoked: invite.revoked,
    ...(invite.description ? { description: invite.description } : {}),
    ...(invite.email ? { email: invite.email } : {})
  };
}

function summarizeDevice(device: StoredDevice): DeviceSummary {
  return {
    id: device.id,
    hostname: device.hostname,
    ...(device.os ? { os: device.os } : {}),
    authorized: device.authorized,
    ephemeral: device.ephemeral,
    createdAt: device.createdAt,
    ...(device.lastSeen ? { lastSeen: device.lastSeen } : {})
  };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function cleanLabel(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength);
}
