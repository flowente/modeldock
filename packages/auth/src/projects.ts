import { randomUUID } from "node:crypto";
import type { AccessSubject, Account, AccountStore, Clock, Project, ProjectStore } from "@modeldock/core";
import { ModelDockError } from "@modeldock/core";

export const PROJECT_LIMITS = {
  name: 60,
  description: 160,
  instructions: 20_000,
  reference: 60_000
} as const;

/** What the chat needs to list and pick a project; the texts come with the full view. */
export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  model?: string;
  owner: { id: string; displayName: string };
  /** Given to other people or groups. */
  shared: boolean;
  /** The account asking may change it. */
  editable: boolean;
  /** Characters of instructions and references: what every reply has to read. */
  contextChars: number;
}

export interface ProjectView extends ProjectSummary {
  instructions: string;
  reference: string;
  access: AccessSubject[];
}

export interface ProjectInput {
  name: unknown;
  description: unknown;
  instructions: unknown;
  reference: unknown;
  model: unknown;
  /** Only administrators may set it: they know the people and groups. */
  access?: unknown;
}

function fail(code: string, message: string, httpStatus: number): never {
  throw new ModelDockError({ code, message, module: "projects", httpStatus });
}

/**
 * Projects: instructions and reference texts for whole conversations. Anyone can make one for
 * themselves; administrators can give a project to people and groups, and manage all of them.
 * Someone without access is told a project does not exist.
 */
export class ProjectService {
  private readonly store: ProjectStore;
  private readonly accounts: AccountStore;
  private readonly clock: Clock;

  public constructor(store: ProjectStore, accounts: AccountStore, clock: Clock) {
    this.store = store;
    this.accounts = accounts;
    this.clock = clock;
  }

  /** Projects the account can use in chat: its own and those given to it or its groups. */
  public async listUsable(account: Account): Promise<ProjectSummary[]> {
    const names = await this.ownerNames();
    return (await this.store.list()).filter((project) => canUse(project, account)).map((project) => summarize(project, account, names));
  }

  /** For the settings: administrators see every project, the others their own and those given to them. */
  public async listForSettings(account: Account): Promise<ProjectSummary[]> {
    const names = await this.ownerNames();
    return (await this.store.list())
      .filter((project) => isAdmin(account) || canUse(project, account))
      .map((project) => summarize(project, account, names));
  }

  public async get(account: Account, id: string): Promise<ProjectView> {
    const project = await this.store.findById(id);
    if (!project || !(isAdmin(account) || canUse(project, account))) fail("PROJECT_NOT_FOUND", "Project not found.", 404);
    return full(project, account, await this.ownerNames());
  }

  /** The project a conversation will use, or a 404 when the account may not use it. */
  public async findUsable(account: Account, id: string): Promise<Project> {
    const project = await this.store.findById(id);
    if (!project || !(isAdmin(account) || canUse(project, account))) fail("PROJECT_NOT_FOUND", "Project not found.", 404);
    return project;
  }

  public async create(account: Account, input: ProjectInput): Promise<ProjectView> {
    const fields = validate(input);
    const access = isAdmin(account) ? await this.validateAccess(input.access) : [];
    const now = this.clock.now().toISOString();
    const project: Project = { id: `prj_${randomUUID()}`, ownerId: account.id, ...fields, access, createdAt: now, updatedAt: now };
    await this.store.insert(project);
    return full(project, account, await this.ownerNames());
  }

  public async update(account: Account, id: string, input: ProjectInput): Promise<ProjectView> {
    const project = await this.requireEditable(account, id);
    const fields = validate(input);
    const updatedAt = this.clock.now().toISOString();
    await this.store.update(id, { ...fields, updatedAt });
    if (input.access !== undefined) {
      if (!isAdmin(account)) fail("AUTH_FORBIDDEN", "Only administrators give projects to other people.", 403);
      await this.store.setAccess(id, await this.validateAccess(input.access));
    }
    return this.get(account, project.id);
  }

  /** The conversations stay, without the project. */
  public async delete(account: Account, id: string): Promise<void> {
    await this.requireEditable(account, id);
    await this.store.delete(id);
  }

  private async requireEditable(account: Account, id: string): Promise<Project> {
    const project = await this.store.findById(id);
    if (!project || !(isAdmin(account) || canUse(project, account))) fail("PROJECT_NOT_FOUND", "Project not found.", 404);
    if (!(isAdmin(account) || project.ownerId === account.id)) fail("AUTH_FORBIDDEN", "Only its owner or an administrator changes a project.", 403);
    return project;
  }

  private async ownerNames(): Promise<Map<string, string>> {
    return new Map((await this.accounts.listAccounts()).map((account) => [account.id, account.displayName]));
  }

  private async validateAccess(value: unknown): Promise<AccessSubject[]> {
    if (value === undefined) return [];
    if (!Array.isArray(value)) fail("PROJECT_ACCESS_INVALID", "Access is a list of people and groups.", 400);
    const users = new Set((await this.accounts.listAccounts()).map((account) => account.id));
    const groups = new Set((await this.accounts.listGroups()).map((group) => group.id));
    return value.map((item) => {
      const subject = item as { type?: unknown; id?: unknown };
      const type = subject.type === "user" || subject.type === "group" ? subject.type : fail("PROJECT_ACCESS_INVALID", "Unknown kind of access.", 400);
      const id = String(subject.id ?? "");
      if (!(type === "user" ? users : groups).has(id)) fail("PROJECT_ACCESS_INVALID", `Unknown ${type}: ${id}.`, 400);
      return { type, id };
    });
  }
}

function isAdmin(account: Account): boolean {
  return account.role === "admin";
}

/** Its owner, or someone it was given to. Administrators reach every project, but through isAdmin. */
function canUse(project: Project, account: Account): boolean {
  return project.ownerId === account.id || project.access.some((subject) => (subject.type === "user" ? subject.id === account.id : account.groupIds.includes(subject.id)));
}

function summarize(project: Project, account: Account, names: Map<string, string>): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    ...(project.model ? { model: project.model } : {}),
    owner: { id: project.ownerId, displayName: names.get(project.ownerId) ?? "" },
    shared: project.access.length > 0,
    editable: isAdmin(account) || project.ownerId === account.id,
    contextChars: project.instructions.length + project.reference.length
  };
}

function full(project: Project, account: Account, names: Map<string, string>): ProjectView {
  return { ...summarize(project, account, names), instructions: project.instructions, reference: project.reference, access: project.access };
}

function text(value: unknown, max: number, field: string, required = false): string {
  const result = String(value ?? "").trim();
  if (required && !result) fail("PROJECT_FIELD_INVALID", `The ${field} is required.`, 400);
  if (result.length > max) fail("PROJECT_FIELD_INVALID", `The ${field} is at most ${max} characters.`, 400);
  return result;
}

function validate(input: ProjectInput): { name: string; description: string; instructions: string; reference: string; model?: string } {
  const model = String(input.model ?? "").trim();
  return {
    name: text(String(input.name ?? "").replace(/[\u0000-\u001f\u007f]/g, " "), PROJECT_LIMITS.name, "name", true),
    description: text(String(input.description ?? "").replace(/[\u0000-\u001f\u007f]/g, " "), PROJECT_LIMITS.description, "description"),
    instructions: text(input.instructions, PROJECT_LIMITS.instructions, "instructions"),
    reference: text(input.reference, PROJECT_LIMITS.reference, "reference"),
    ...(model ? { model } : {})
  };
}
