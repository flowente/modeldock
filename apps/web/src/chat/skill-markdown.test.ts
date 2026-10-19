import { describe, expect, it } from "vitest";
import { parseSkillMarkdown, toSkillMarkdown, toSkillName } from "./skill-markdown.ts";

describe("skill Markdown files", () => {
  it("reads a SKILL.md with front matter", () => {
    const file = "---\nname: verbale-riunione\ndescription: Trasforma appunti in un verbale\n---\n\n# Verbale\n\n- Partecipanti\n- **Decisioni**\n";
    expect(parseSkillMarkdown(file)).toEqual({
      name: "verbale-riunione",
      description: "Trasforma appunti in un verbale",
      instruction: "# Verbale\n\n- Partecipanti\n- **Decisioni**"
    });
  });

  it("handles quotes, folded descriptions, Windows line ends and a byte-order mark", () => {
    const file = '﻿---\r\nname: "Email: formale"\r\ndescription: >\r\n  Scrive email\r\n  formali, in italiano\r\n---\r\nTesto';
    expect(parseSkillMarkdown(file)).toEqual({ name: "email-formale", description: "Scrive email formali, in italiano", instruction: "Testo" });
  });

  it("without front matter, takes the name from the first heading or the file name", () => {
    expect(parseSkillMarkdown("# Riassunto Settimanale\n\nFai così.").name).toBe("riassunto-settimanale");
    expect(parseSkillMarkdown("Solo istruzioni.", "Città e Più.md").name).toBe("citta-e-piu");
  });

  it("cuts a long description at a word and keeps it under the limit", () => {
    const long = "Usa questa skill quando " + "serve qualcosa di preciso ".repeat(20);
    const description = parseSkillMarkdown(`---\nname: x\ndescription: ${long}\n---\nok`).description;
    expect(description.length).toBeLessThanOrEqual(120);
    expect(description.endsWith("…")).toBe(true);
    expect(description).not.toMatch(/\s…$/);
  });

  it("writes a file that reads back the same", () => {
    const skill = { name: "email", description: 'Con "virgolette": e due punti', instruction: "# Email\n\nScrivi bene." };
    expect(parseSkillMarkdown(toSkillMarkdown(skill))).toEqual(skill);
  });

  it("makes valid names", () => {
    expect(toSkillName("  Già Fatto!! ")).toBe("gia-fatto");
    expect(toSkillName("a".repeat(40))).toHaveLength(32);
  });
});
