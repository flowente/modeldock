import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface StoredInvite {
  id: string;
  /** Mai il segreto: solo il suo SHA-256. */
  secretHash: string;
  pinHash?: string;
  createdAt: string;
  expiresAt: string;
  reusable: boolean;
  preauthorized: boolean;
  ephemeral: boolean;
  tags: string[];
  description?: string;
  email?: string;
  uses: number;
  failedPinAttempts: number;
  revoked: boolean;
}

export interface StoredDevice {
  id: string;
  hostname: string;
  os?: string;
  /** Mai il token: solo il suo SHA-256. */
  tokenHash: string;
  authorized: boolean;
  ephemeral: boolean;
  inviteId: string;
  createdAt: string;
  lastSeen?: string;
}

export interface LinkState {
  version: 1;
  invites: StoredInvite[];
  devices: StoredDevice[];
}

export interface StateStore {
  load(): Promise<LinkState>;
  save(state: LinkState): Promise<void>;
}

export function emptyState(): LinkState {
  return { version: 1, invites: [], devices: [] };
}

export class MemoryStateStore implements StateStore {
  private state: LinkState = emptyState();

  public async load(): Promise<LinkState> {
    return structuredClone(this.state);
  }

  public async save(state: LinkState): Promise<void> {
    this.state = structuredClone(state);
  }
}

/**
 * Stato su file JSON. Si rilegge a ogni operazione, così il server e la riga di
 * comando possono lavorare sullo stesso file. Scrittura atomica: file temporaneo + rename.
 */
export class FileStateStore implements StateStore {
  private readonly path: string;

  public constructor(path: string) {
    this.path = path;
  }

  public async load(): Promise<LinkState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as LinkState;
      if (parsed.version !== 1) throw new Error(`Versione dello stato non supportata: ${String(parsed.version)}`);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  public async save(state: LinkState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
