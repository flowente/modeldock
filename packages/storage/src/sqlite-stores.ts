import type {
  AccessGroup,
  AccessUser,
  AccountPatch,
  AccountStore,
  ApiKeyStore,
  ApiUsageByModel,
  ApiUsageDay,
  ApiUsageEntry,
  ApiUsageStore,
  ApiUsageTotals,
  AuditEvent,
  AuditEventInput,
  AuditResult,
  AuditStore,
  ChatMessage,
  ChatStore,
  Clock,
  Conversation,
  IdGenerator,
  ModelAccessGrant,
  ModelAccessPolicy,
  ModelAccessStore,
  QuickCommand,
  QuickCommandStore,
  Role,
  StoredAccount,
  StoredApiKey,
  StoredGroup,
  StoredInvitation,
  StoredSession,
  UpdateModelAccessPolicyInput
} from "@modeldock/core";
import { ModelDockError } from "@modeldock/core";
import { transaction, type Database } from "./database.ts";

type Row = Record<string, unknown>;
type SqlValue = string | number | null;

function text(value: unknown): string {
  return String(value);
}

function optional(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function nullable(value: string | undefined): SqlValue {
  return value ?? null;
}

export class SqliteAuditStore implements AuditStore {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  public constructor(db: Database, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  public async append(input: AuditEventInput): Promise<AuditEvent> {
    const event: AuditEvent = { id: this.ids.createId("audit"), timestamp: this.clock.now().toISOString(), ...input };
    this.db
      .prepare(
        `INSERT INTO audit_events (id, timestamp, actor_id, action, module, result, correlation_id, resource_type, resource_id, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.timestamp,
        event.actorId,
        event.action,
        event.module,
        event.result,
        event.correlationId,
        nullable(event.resourceType),
        nullable(event.resourceId),
        nullable(event.errorCode)
      );
    return event;
  }

  public async list(limit = 50): Promise<AuditEvent[]> {
    const rows = this.db.prepare("SELECT * FROM audit_events ORDER BY timestamp DESC, rowid DESC LIMIT ?").all(limit) as Row[];
    return rows.map((row) => ({
      id: text(row.id),
      timestamp: text(row.timestamp),
      actorId: text(row.actor_id),
      action: text(row.action),
      module: text(row.module),
      result: text(row.result) as AuditResult,
      correlationId: text(row.correlation_id),
      ...(row.resource_type ? { resourceType: text(row.resource_type) } : {}),
      ...(row.resource_id ? { resourceId: text(row.resource_id) } : {}),
      ...(row.error_code ? { errorCode: text(row.error_code) } : {})
    }));
  }
}

export class SqliteAccountStore implements AccountStore {
  private readonly db: Database;

  public constructor(db: Database) {
    this.db = db;
  }

  public async countAccounts(): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM users").get() as { total: number };
    return Number(row.total);
  }

  public async listAccounts(): Promise<StoredAccount[]> {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY created_at, rowid").all() as Row[];
    const memberships = this.membershipsByUser();
    return rows.map((row) => toAccount(row, memberships.get(text(row.id)) ?? []));
  }

  public async findAccountById(id: string): Promise<StoredAccount | undefined> {
    return this.findAccount("SELECT * FROM users WHERE id = ?", id);
  }

  public async findAccountByEmail(email: string): Promise<StoredAccount | undefined> {
    return this.findAccount("SELECT * FROM users WHERE email = ?", email.trim());
  }

  public async insertAccount(account: StoredAccount): Promise<void> {
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO users (id, email, display_name, role, status, password_hash, created_at, updated_at, last_login_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          account.id,
          account.email,
          account.displayName,
          account.role,
          account.status,
          nullable(account.passwordHash),
          account.createdAt,
          account.updatedAt,
          nullable(account.lastLoginAt)
        );
      this.replaceMemberships(account.id, account.groupIds);
    });
  }

  public async updateAccount(id: string, patch: AccountPatch): Promise<void> {
    const columns: Array<[string, SqlValue]> = [["updated_at", patch.updatedAt]];
    if (patch.displayName !== undefined) columns.push(["display_name", patch.displayName]);
    if (patch.role !== undefined) columns.push(["role", patch.role]);
    if (patch.status !== undefined) columns.push(["status", patch.status]);
    if (patch.passwordHash !== undefined) columns.push(["password_hash", patch.passwordHash]);
    if (patch.lastLoginAt !== undefined) columns.push(["last_login_at", patch.lastLoginAt]);

    transaction(this.db, () => {
      this.db
        .prepare(`UPDATE users SET ${columns.map(([name]) => `${name} = ?`).join(", ")} WHERE id = ?`)
        .run(...columns.map(([, value]) => value), id);
      if (patch.groupIds) this.replaceMemberships(id, patch.groupIds);
    });
  }

  public async deleteAccount(id: string): Promise<void> {
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
  }

  public async listGroups(): Promise<StoredGroup[]> {
    const rows = this.db.prepare("SELECT * FROM groups ORDER BY name COLLATE NOCASE").all() as Row[];
    return rows.map(toGroup);
  }

  public async findGroupById(id: string): Promise<StoredGroup | undefined> {
    const row = this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as Row | undefined;
    return row ? toGroup(row) : undefined;
  }

  public async insertGroup(group: StoredGroup): Promise<void> {
    this.db
      .prepare("INSERT INTO groups (id, name, description, created_at) VALUES (?, ?, ?, ?)")
      .run(group.id, group.name, nullable(group.description), group.createdAt);
  }

  public async updateGroup(id: string, patch: { name?: string; description?: string | null }): Promise<void> {
    const columns: Array<[string, SqlValue]> = [];
    if (patch.name !== undefined) columns.push(["name", patch.name]);
    if (patch.description !== undefined) columns.push(["description", patch.description]);
    if (columns.length === 0) return;
    this.db
      .prepare(`UPDATE groups SET ${columns.map(([name]) => `${name} = ?`).join(", ")} WHERE id = ?`)
      .run(...columns.map(([, value]) => value), id);
  }

  public async deleteGroup(id: string): Promise<void> {
    transaction(this.db, () => {
      // Grants point at groups by id without a foreign key (a subject can be a user or a group).
      this.db.prepare("DELETE FROM model_grants WHERE subject_type = 'group' AND subject_id = ?").run(id);
      this.db.prepare("DELETE FROM groups WHERE id = ?").run(id);
    });
  }

  public async insertSession(session: StoredSession): Promise<void> {
    this.db
      .prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
      .run(session.idHash, session.userId, session.createdAt, session.expiresAt, session.lastSeenAt, nullable(session.userAgent));
  }

  public async findSession(idHash: string): Promise<StoredSession | undefined> {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id_hash = ?").get(idHash) as Row | undefined;
    if (!row) return undefined;
    return {
      idHash: text(row.id_hash),
      userId: text(row.user_id),
      createdAt: text(row.created_at),
      expiresAt: text(row.expires_at),
      lastSeenAt: text(row.last_seen_at),
      ...(row.user_agent ? { userAgent: text(row.user_agent) } : {})
    };
  }

  public async touchSession(idHash: string, lastSeenAt: string, expiresAt: string): Promise<void> {
    this.db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?").run(lastSeenAt, expiresAt, idHash);
  }

  public async deleteSession(idHash: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
  }

  public async deleteSessionsForUser(userId: string, exceptIdHash?: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash IS NOT ?").run(userId, nullable(exceptIdHash));
  }

  public async deleteExpiredSessions(now: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  }

  public async insertInvitation(invitation: StoredInvitation): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO invitations (id, token_hash, email, display_name, role, group_ids, created_by, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        invitation.id,
        invitation.tokenHash,
        invitation.email,
        invitation.displayName,
        invitation.role,
        JSON.stringify(invitation.groupIds),
        invitation.createdBy,
        invitation.createdAt,
        invitation.expiresAt,
        nullable(invitation.usedAt)
      );
  }

  public async listInvitations(): Promise<StoredInvitation[]> {
    const rows = this.db.prepare("SELECT * FROM invitations ORDER BY created_at DESC, rowid DESC").all() as Row[];
    return rows.map(toInvitation);
  }

  public async findInvitationByTokenHash(tokenHash: string): Promise<StoredInvitation | undefined> {
    const row = this.db.prepare("SELECT * FROM invitations WHERE token_hash = ?").get(tokenHash) as Row | undefined;
    return row ? toInvitation(row) : undefined;
  }

  public async consumeInvitation(id: string, usedAt: string): Promise<boolean> {
    const result = this.db.prepare("UPDATE invitations SET used_at = ? WHERE id = ? AND used_at IS NULL").run(usedAt, id);
    return Number(result.changes) === 1;
  }

  public async deleteInvitation(id: string): Promise<void> {
    this.db.prepare("DELETE FROM invitations WHERE id = ?").run(id);
  }

  private findAccount(sql: string, value: string): StoredAccount | undefined {
    const row = this.db.prepare(sql).get(value) as Row | undefined;
    if (!row) return undefined;
    const groups = this.db.prepare("SELECT group_id FROM group_members WHERE user_id = ? ORDER BY group_id").all(text(row.id)) as Row[];
    return toAccount(row, groups.map((group) => text(group.group_id)));
  }

  private membershipsByUser(): Map<string, string[]> {
    const rows = this.db.prepare("SELECT user_id, group_id FROM group_members ORDER BY group_id").all() as Row[];
    const result = new Map<string, string[]>();
    for (const row of rows) {
      const list = result.get(text(row.user_id)) ?? [];
      list.push(text(row.group_id));
      result.set(text(row.user_id), list);
    }
    return result;
  }

  private replaceMemberships(userId: string, groupIds: string[]): void {
    this.db.prepare("DELETE FROM group_members WHERE user_id = ?").run(userId);
    const insert = this.db.prepare("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)");
    for (const groupId of new Set(groupIds)) insert.run(groupId, userId);
  }
}

/**
 * Model permissions on the same database as the accounts, so users and groups
 * shown here are the real ones.
 */
export class SqliteModelAccessStore implements ModelAccessStore {
  private readonly db: Database;
  private readonly accounts: SqliteAccountStore;

  public constructor(db: Database) {
    this.db = db;
    this.accounts = new SqliteAccountStore(db);
  }

  public async listUsers(): Promise<AccessUser[]> {
    return (await this.accounts.listAccounts()).map((account) => ({
      id: account.id,
      displayName: account.displayName,
      role: account.role,
      groupIds: [...account.groupIds]
    }));
  }

  public async listGroups(): Promise<AccessGroup[]> {
    return (await this.accounts.listGroups()).map(({ createdAt: _createdAt, ...group }) => group);
  }

  public async listPolicies(): Promise<ModelAccessPolicy[]> {
    const policies = this.db.prepare("SELECT * FROM model_policies ORDER BY model_name").all() as Row[];
    const grants = this.grantsByModel();
    return policies.map((row) => toPolicy(row, grants.get(text(row.model_name)) ?? []));
  }

  /**
   * A model seen for the first time is enabled but granted to nobody:
   * only administrators (who always pass) can use it until someone decides otherwise.
   */
  public async ensurePolicy(modelName: string): Promise<ModelAccessPolicy> {
    this.db.prepare("INSERT OR IGNORE INTO model_policies (model_name, enabled, loaded) VALUES (?, 1, 0)").run(modelName);
    return this.readPolicy(modelName)!;
  }

  public async deletePolicy(modelName: string): Promise<void> {
    this.db.prepare("DELETE FROM model_policies WHERE model_name = ?").run(modelName);
  }

  public async updatePolicy(input: UpdateModelAccessPolicyInput): Promise<ModelAccessPolicy> {
    if (!this.readPolicy(input.modelName)) {
      throw new ModelDockError({
        code: "MODEL_ACCESS_POLICY_NOT_FOUND",
        module: "access-control",
        message: `No access policy exists for model ${input.modelName}`,
        httpStatus: 404
      });
    }

    transaction(this.db, () => {
      if (typeof input.enabled === "boolean") {
        this.db.prepare("UPDATE model_policies SET enabled = ? WHERE model_name = ?").run(input.enabled ? 1 : 0, input.modelName);
      }
      if (typeof input.loaded === "boolean") {
        this.db.prepare("UPDATE model_policies SET loaded = ? WHERE model_name = ?").run(input.loaded ? 1 : 0, input.modelName);
      }
      for (const [groupId, canUse] of Object.entries(input.groupGrants ?? {})) {
        if (canUse) {
          this.db
            .prepare("INSERT OR REPLACE INTO model_grants (model_name, subject_type, subject_id, can_use) VALUES (?, 'group', ?, 1)")
            .run(input.modelName, groupId);
        } else {
          this.db.prepare("DELETE FROM model_grants WHERE model_name = ? AND subject_type = 'group' AND subject_id = ?").run(input.modelName, groupId);
        }
      }
    });

    return this.readPolicy(input.modelName)!;
  }

  /** Grants or revokes a model for one account, on top of its groups. */
  public async setUserGrant(modelName: string, userId: string, canUse: boolean): Promise<ModelAccessPolicy> {
    await this.ensurePolicy(modelName);
    if (canUse) {
      this.db
        .prepare("INSERT OR REPLACE INTO model_grants (model_name, subject_type, subject_id, can_use) VALUES (?, 'user', ?, 1)")
        .run(modelName, userId);
    } else {
      this.db.prepare("DELETE FROM model_grants WHERE model_name = ? AND subject_type = 'user' AND subject_id = ?").run(modelName, userId);
    }
    return this.readPolicy(modelName)!;
  }

  private readPolicy(modelName: string): ModelAccessPolicy | undefined {
    const row = this.db.prepare("SELECT * FROM model_policies WHERE model_name = ?").get(modelName) as Row | undefined;
    if (!row) return undefined;
    const grants = this.db.prepare("SELECT * FROM model_grants WHERE model_name = ? ORDER BY subject_type, subject_id").all(modelName) as Row[];
    return toPolicy(row, grants.map(toGrant));
  }

  private grantsByModel(): Map<string, ModelAccessGrant[]> {
    const rows = this.db.prepare("SELECT * FROM model_grants ORDER BY subject_type, subject_id").all() as Row[];
    const result = new Map<string, ModelAccessGrant[]>();
    for (const row of rows) {
      const list = result.get(text(row.model_name)) ?? [];
      list.push(toGrant(row));
      result.set(text(row.model_name), list);
    }
    return result;
  }
}

function toAccount(row: Row, groupIds: string[]): StoredAccount {
  return {
    id: text(row.id),
    email: text(row.email),
    displayName: text(row.display_name),
    role: text(row.role) as Role,
    status: text(row.status) as StoredAccount["status"],
    groupIds,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    ...(row.last_login_at ? { lastLoginAt: text(row.last_login_at) } : {}),
    ...(row.password_hash ? { passwordHash: text(row.password_hash) } : {})
  };
}

function toGroup(row: Row): StoredGroup {
  const description = optional(row.description);
  return {
    id: text(row.id),
    name: text(row.name),
    ...(description ? { description } : {}),
    createdAt: text(row.created_at)
  };
}

function toInvitation(row: Row): StoredInvitation {
  return {
    id: text(row.id),
    tokenHash: text(row.token_hash),
    email: text(row.email),
    displayName: text(row.display_name),
    role: text(row.role) as Role,
    groupIds: JSON.parse(text(row.group_ids)) as string[],
    createdBy: text(row.created_by),
    createdAt: text(row.created_at),
    expiresAt: text(row.expires_at),
    ...(row.used_at ? { usedAt: text(row.used_at) } : {})
  };
}

function toPolicy(row: Row, grants: ModelAccessGrant[]): ModelAccessPolicy {
  return {
    modelName: text(row.model_name),
    enabled: Number(row.enabled) === 1,
    loaded: Number(row.loaded) === 1,
    grants
  };
}

function toGrant(row: Row): ModelAccessGrant {
  return {
    subject: { type: text(row.subject_type) as "user" | "group", id: text(row.subject_id) },
    canUse: Number(row.can_use) === 1
  };
}

export class SqliteChatStore implements ChatStore {
  private readonly db: Database;

  public constructor(db: Database) {
    this.db = db;
  }

  public async listConversations(userId: string, query?: string): Promise<Conversation[]> {
    const term = query?.trim();
    if (!term) {
      const rows = this.db.prepare("SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC").all(userId) as Row[];
      return rows.map(toConversation);
    }
    // LIKE wildcards typed by the user are taken literally.
    const pattern = `%${term.replace(/[!%_]/g, (character) => `!${character}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM conversations c WHERE c.user_id = ? AND (
           c.title LIKE ? ESCAPE '!'
           OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '!')
         ) ORDER BY c.updated_at DESC, c.rowid DESC`
      )
      .all(userId, pattern, pattern) as Row[];
    return rows.map(toConversation);
  }

  public async findConversation(id: string): Promise<Conversation | undefined> {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Row | undefined;
    return row ? toConversation(row) : undefined;
  }

  public async insertConversation(conversation: Conversation): Promise<void> {
    this.db
      .prepare("INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(conversation.id, conversation.userId, conversation.title, nullable(conversation.model), conversation.createdAt, conversation.updatedAt);
  }

  public async updateConversation(id: string, patch: { title?: string; model?: string; updatedAt: string }): Promise<void> {
    const columns: Array<[string, SqlValue]> = [["updated_at", patch.updatedAt]];
    if (patch.title !== undefined) columns.push(["title", patch.title]);
    if (patch.model !== undefined) columns.push(["model", patch.model]);
    this.db
      .prepare(`UPDATE conversations SET ${columns.map(([name]) => `${name} = ?`).join(", ")} WHERE id = ?`)
      .run(...columns.map(([, value]) => value), id);
  }

  public async deleteConversation(id: string): Promise<void> {
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  }

  public async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const rows = this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq").all(conversationId) as Row[];
    return rows.map((row) => ({
      id: text(row.id),
      conversationId: text(row.conversation_id),
      role: text(row.role) as ChatMessage["role"],
      content: text(row.content),
      ...(row.model ? { model: text(row.model) } : {}),
      status: text(row.status) as ChatMessage["status"],
      createdAt: text(row.created_at),
      ...(row.command ? { command: text(row.command) } : {})
    }));
  }

  public async insertMessage(message: ChatMessage): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, seq, role, content, model, status, created_at, command)
         VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?), ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        message.conversationId,
        message.conversationId,
        message.role,
        message.content,
        nullable(message.model),
        message.status,
        message.createdAt,
        nullable(message.command)
      );
  }
}

export class SqliteApiKeyStore implements ApiKeyStore {
  private readonly db: Database;

  public constructor(db: Database) {
    this.db = db;
  }

  public async insertApiKey(key: StoredApiKey): Promise<void> {
    this.db
      .prepare("INSERT INTO api_keys (id, user_id, name, key_hash, hint, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(key.id, key.userId, key.name, key.keyHash, key.hint, key.createdAt, nullable(key.lastUsedAt), nullable(key.revokedAt));
  }

  public async listApiKeys(userId?: string): Promise<StoredApiKey[]> {
    const rows = (
      userId === undefined
        ? this.db.prepare("SELECT * FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC, rowid DESC").all()
        : this.db.prepare("SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC").all(userId)
    ) as Row[];
    return rows.map(toApiKey);
  }

  public async findApiKeyById(id: string): Promise<StoredApiKey | undefined> {
    const row = this.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as Row | undefined;
    return row ? toApiKey(row) : undefined;
  }

  public async findApiKeyByHash(keyHash: string): Promise<StoredApiKey | undefined> {
    const row = this.db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(keyHash) as Row | undefined;
    return row ? toApiKey(row) : undefined;
  }

  public async touchApiKey(id: string, lastUsedAt: string): Promise<void> {
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(lastUsedAt, id);
  }

  public async revokeApiKey(id: string, revokedAt: string): Promise<void> {
    this.db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(revokedAt, id);
  }
}

const TOTALS = `COUNT(*) AS calls,
  SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
  COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0) AS completion_tokens`;

function toTotals(row: Row): ApiUsageTotals {
  return {
    calls: Number(row.calls ?? 0),
    errors: Number(row.errors ?? 0),
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0)
  };
}

export class SqliteApiUsageStore implements ApiUsageStore {
  private readonly db: Database;

  public constructor(db: Database) {
    this.db = db;
  }

  public async record(entry: ApiUsageEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO api_usage (key_id, model, endpoint, status, streamed, prompt_tokens, completion_tokens, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.keyId,
        entry.model,
        entry.endpoint,
        entry.status,
        entry.streamed ? 1 : 0,
        entry.promptTokens,
        entry.completionTokens,
        entry.durationMs,
        entry.createdAt
      );
  }

  public async totalsByKey(keyIds: string[], since: string): Promise<Map<string, ApiUsageTotals>> {
    const result = new Map<string, ApiUsageTotals>();
    if (keyIds.length === 0) return result;
    const rows = this.db
      .prepare(`SELECT key_id, ${TOTALS} FROM api_usage WHERE created_at >= ? AND key_id IN (${keyIds.map(() => "?").join(", ")}) GROUP BY key_id`)
      .all(since, ...keyIds) as Row[];
    for (const row of rows) result.set(text(row.key_id), toTotals(row));
    return result;
  }

  public async daily(keyId: string, since: string, offsetMinutes: number): Promise<ApiUsageDay[]> {
    const shift = `${Math.trunc(offsetMinutes) >= 0 ? "+" : ""}${Math.trunc(offsetMinutes)} minutes`;
    const rows = this.db
      .prepare(`SELECT date(created_at, ?) AS day, ${TOTALS} FROM api_usage WHERE key_id = ? AND created_at >= ? GROUP BY day ORDER BY day`)
      .all(shift, keyId, since) as Row[];
    return rows.map((row) => ({ day: text(row.day), ...toTotals(row) }));
  }

  public async byModel(keyId: string, since: string): Promise<ApiUsageByModel[]> {
    const rows = this.db
      .prepare(`SELECT model, ${TOTALS} FROM api_usage WHERE key_id = ? AND created_at >= ? GROUP BY model ORDER BY calls DESC, model`)
      .all(keyId, since) as Row[];
    return rows.map((row) => ({ model: text(row.model), ...toTotals(row) }));
  }

  public async recent(keyId: string, limit: number): Promise<ApiUsageEntry[]> {
    const rows = this.db.prepare("SELECT * FROM api_usage WHERE key_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(keyId, limit) as Row[];
    return rows.map((row) => ({
      keyId: text(row.key_id),
      model: text(row.model),
      endpoint: text(row.endpoint) as ApiUsageEntry["endpoint"],
      status: Number(row.status),
      streamed: Number(row.streamed) === 1,
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      durationMs: Number(row.duration_ms),
      createdAt: text(row.created_at)
    }));
  }

  public async deleteOlderThan(before: string): Promise<void> {
    this.db.prepare("DELETE FROM api_usage WHERE created_at < ?").run(before);
  }
}

function toApiKey(row: Row): StoredApiKey {
  return {
    id: text(row.id),
    userId: text(row.user_id),
    name: text(row.name),
    keyHash: text(row.key_hash),
    hint: text(row.hint),
    createdAt: text(row.created_at),
    ...(row.last_used_at ? { lastUsedAt: text(row.last_used_at) } : {}),
    ...(row.revoked_at ? { revokedAt: text(row.revoked_at) } : {})
  };
}

function toConversation(row: Row): Conversation {
  return {
    id: text(row.id),
    userId: text(row.user_id),
    title: text(row.title),
    ...(row.model ? { model: text(row.model) } : {}),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at)
  };
}

export class SqliteQuickCommandStore implements QuickCommandStore {
  private readonly db: Database;

  public constructor(db: Database) {
    this.db = db;
  }

  public async listVisible(accountId: string): Promise<QuickCommand[]> {
    const rows = this.db.prepare("SELECT * FROM quick_commands WHERE owner_id IS NULL OR owner_id = ? ORDER BY name, owner_id").all(accountId) as Row[];
    return rows.map(toQuickCommand);
  }

  public async findById(id: string): Promise<QuickCommand | undefined> {
    const row = this.db.prepare("SELECT * FROM quick_commands WHERE id = ?").get(id) as Row | undefined;
    return row ? toQuickCommand(row) : undefined;
  }

  public async insert(command: QuickCommand): Promise<void> {
    this.db
      .prepare("INSERT INTO quick_commands (id, owner_id, name, description, instruction, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(command.id, nullable(command.ownerId), command.name, command.description, command.instruction, command.createdAt, command.updatedAt);
  }

  public async update(id: string, patch: { name: string; description: string; instruction: string; updatedAt: string }): Promise<void> {
    this.db
      .prepare("UPDATE quick_commands SET name = ?, description = ?, instruction = ?, updated_at = ? WHERE id = ?")
      .run(patch.name, patch.description, patch.instruction, patch.updatedAt, id);
  }

  public async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM quick_commands WHERE id = ?").run(id);
  }
}

function toQuickCommand(row: Row): QuickCommand {
  return {
    id: text(row.id),
    ...(row.owner_id ? { ownerId: text(row.owner_id) } : {}),
    name: text(row.name),
    description: text(row.description),
    instruction: text(row.instruction),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at)
  };
}
