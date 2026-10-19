/**
 * Skills as Markdown files, in the format other assistants use (Claude's SKILL.md among them):
 * a front matter with `name` and `description`, then the instructions.
 *
 *   ---
 *   name: verbale
 *   description: Trasforma appunti in un verbale
 *   ---
 *
 *   # Verbale di riunione
 *   ...
 */

export interface SkillFields {
  name: string;
  description: string;
  instruction: string;
}

export const MAX_DESCRIPTION = 120;
export const MAX_INSTRUCTION = 20_000;

/** A file name, a title or a free name → a valid skill name: lowercase, digits, dashes. */
export function toSkillName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

/** Long descriptions (other assistants allow a thousand characters) are cut at a word. */
function shorten(value: string): string {
  if (value.length <= MAX_DESCRIPTION) return value;
  const cut = value.slice(0, MAX_DESCRIPTION - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 60)).trimEnd()}…`;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      return String(JSON.parse(trimmed));
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}

/** Reads the few front matter keys a skill needs; folded (`>`) and literal (`|`) blocks included. */
function readFrontMatter(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = block.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[index]!);
    if (!match) continue;
    const [, key, raw] = match as unknown as [string, string, string];
    if (raw === ">" || raw === "|" || raw === ">-" || raw === "|-") {
      const body: string[] = [];
      while (index + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[index + 1]!)) body.push(lines[(index += 1)]!.trim());
      result[key] = raw.startsWith(">") ? body.filter(Boolean).join(" ") : body.join("\n").trim();
    } else {
      result[key] = unquote(raw);
    }
  }
  return result;
}

/**
 * A Markdown file → a skill. Without a front matter the name comes from the first heading, or
 * from the file name; the whole text becomes the instructions.
 */
export function parseSkillMarkdown(text: string, fileName = ""): SkillFields {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  let meta: Record<string, string> = {};
  let body = normalized;
  const front = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (front) {
    meta = readFrontMatter(front[1]!);
    body = normalized.slice(front[0].length);
  }
  const heading = /^#\s+(.+)$/m.exec(body)?.[1] ?? "";
  return {
    name: toSkillName(meta.name || heading || fileName),
    description: shorten((meta.description ?? "").replace(/\s+/g, " ").trim()),
    instruction: body.trim().slice(0, MAX_INSTRUCTION)
  };
}

/** A skill → a Markdown file that reads back the same, here or in another assistant. */
export function toSkillMarkdown(skill: SkillFields): string {
  // A double-quoted string is valid YAML whatever the description contains.
  const lines = ["---", `name: ${skill.name}`, `description: ${JSON.stringify(skill.description)}`, "---", "", skill.instruction.trim(), ""];
  return lines.join("\n");
}
