import { randomUUID } from "node:crypto";
import type { Account, Clock, QuickCommand, QuickCommandStore } from "@modeldock/core";
import { ModelDockError } from "@modeldock/core";

const MAX_DESCRIPTION = 120;
/** Room for a real skill written in Markdown, like the ones made for other assistants. */
const MAX_INSTRUCTION = 20_000;

export interface QuickCommandView {
  id: string;
  name: string;
  description: string;
  instruction: string;
  /** For everyone, managed by administrators; otherwise it belongs to the account asking. */
  shared: boolean;
  /** Whether the account asking may change or delete it. */
  editable: boolean;
}

export interface QuickCommandInput {
  name: unknown;
  description: unknown;
  instruction: unknown;
}

function fail(code: string, message: string, httpStatus: number): never {
  throw new ModelDockError({ code, message, module: "quick-commands", httpStatus });
}

/**
 * Skills, called from the chat with "/name" (named "quick commands" in the code and the
 * database, "skill" in the interface): a saved instruction, Markdown welcome, that the model
 * receives with the message. Shared ones are for everyone and only administrators manage them; anyone can keep
 * personal ones. A personal command cannot take a shared one's name, so "/name" is never ambiguous.
 */
export class QuickCommandService {
  private readonly store: QuickCommandStore;
  private readonly clock: Clock;

  public constructor(store: QuickCommandStore, clock: Clock) {
    this.store = store;
    this.clock = clock;
  }

  public async list(account: Account, canManageShared: boolean): Promise<QuickCommandView[]> {
    return (await this.store.listVisible(account.id)).map((command) => view(command, canManageShared));
  }

  /** A command this account may use, or a 404 that does not say whether it exists. */
  public async findUsable(account: Account, id: string): Promise<QuickCommand> {
    const command = await this.store.findById(id);
    if (!command || (command.ownerId && command.ownerId !== account.id)) fail("QUICK_COMMAND_NOT_FOUND", "Quick command not found.", 404);
    return command;
  }

  public async create(input: QuickCommandInput & { account: Account; shared: boolean; canManageShared: boolean }): Promise<QuickCommandView> {
    if (input.shared && !input.canManageShared) fail("AUTH_FORBIDDEN", "Only administrators manage shared commands.", 403);
    const fields = validate(input);
    await this.assertNameFree(fields.name, input.account.id, input.shared);
    const now = this.clock.now().toISOString();
    const command: QuickCommand = {
      id: `qc_${randomUUID()}`,
      ...(input.shared ? {} : { ownerId: input.account.id }),
      ...fields,
      createdAt: now,
      updatedAt: now
    };
    await this.store.insert(command);
    return view(command, input.canManageShared);
  }

  public async update(input: QuickCommandInput & { id: string; account: Account; canManageShared: boolean }): Promise<QuickCommandView> {
    const command = await this.requireEditable(input.id, input.account, input.canManageShared);
    const fields = validate(input);
    if (fields.name !== command.name) await this.assertNameFree(fields.name, input.account.id, !command.ownerId);
    const updatedAt = this.clock.now().toISOString();
    await this.store.update(command.id, { ...fields, updatedAt });
    return view({ ...command, ...fields, updatedAt }, input.canManageShared);
  }

  public async delete(input: { id: string; account: Account; canManageShared: boolean }): Promise<void> {
    const command = await this.requireEditable(input.id, input.account, input.canManageShared);
    await this.store.delete(command.id);
  }

  private async requireEditable(id: string, account: Account, canManageShared: boolean): Promise<QuickCommand> {
    const command = await this.findUsable(account, id);
    if (!command.ownerId && !canManageShared) fail("AUTH_FORBIDDEN", "Only administrators manage shared commands.", 403);
    return command;
  }

  private async assertNameFree(name: string, accountId: string, shared: boolean): Promise<void> {
    const visible = await this.store.listVisible(accountId);
    const clash = visible.some((command) => command.name === name && (shared ? !command.ownerId : true));
    if (clash) fail("QUICK_COMMAND_NAME_TAKEN", `A command named /${name} already exists.`, 409);
  }
}

function view(command: QuickCommand, canManageShared: boolean): QuickCommandView {
  return {
    id: command.id,
    name: command.name,
    description: command.description,
    instruction: command.instruction,
    shared: !command.ownerId,
    editable: command.ownerId ? true : canManageShared
  };
}

function validate(input: QuickCommandInput): { name: string; description: string; instruction: string } {
  const name = String(input.name ?? "")
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
    fail("QUICK_COMMAND_NAME_INVALID", "The name uses lowercase letters, digits and dashes, up to 32 characters.", 400);
  }
  const description = String(input.description ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (description.length > MAX_DESCRIPTION) fail("QUICK_COMMAND_DESCRIPTION_INVALID", `The description is at most ${MAX_DESCRIPTION} characters.`, 400);
  const instruction = String(input.instruction ?? "").trim();
  if (instruction.length === 0 || instruction.length > MAX_INSTRUCTION) {
    fail("QUICK_COMMAND_INSTRUCTION_INVALID", `The instruction is between 1 and ${MAX_INSTRUCTION} characters.`, 400);
  }
  return { name, description, instruction };
}
