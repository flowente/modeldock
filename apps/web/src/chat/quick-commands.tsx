import { useEffect, useState, type KeyboardEvent } from "react";
import type { QuickCommand } from "./chat-api.ts";

/** "/riassumi testo…" → the command and the text after it, when the name is a known command. */
export function parseCommand(text: string, commands: QuickCommand[]): { command: QuickCommand; rest: string } | null {
  const match = /^\/([a-z0-9-]+)(?:\s([\s\S]*))?$/.exec(text);
  if (!match) return null;
  const command = commands.find((candidate) => candidate.name === match[1]);
  // Only once a space follows the name: while still typing "/riass" it is a search.
  return command && match[2] !== undefined ? { command, rest: match[2] } : null;
}

export interface SlashMenuState {
  open: boolean;
  matches: QuickCommand[];
  highlighted: number;
  setHighlighted: (index: number) => void;
  choose: (name: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * The menu that opens when a message starts with "/": commands whose name begins with what is
 * typed. Arrows move, Enter or Tab pick, Escape closes.
 */
export function useSlashMenu(text: string, commands: QuickCommand[], onChoose: (name: string) => void): SlashMenuState {
  const search = /^\/([a-z0-9-]*)$/i.exec(text)?.[1]?.toLowerCase();
  const matches = search === undefined ? [] : commands.filter((command) => command.name.startsWith(search));
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const open = matches.length > 0 && dismissed !== text;

  useEffect(() => setHighlighted(0), [search]);

  const choose = (name: string) => {
    setDismissed(null);
    onChoose(name);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((current) => (current + step + matches.length) % matches.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const picked = matches[highlighted];
      if (picked) choose(picked.name);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(text);
      return true;
    }
    return false;
  };

  return { open, matches, highlighted, setHighlighted, choose, onKeyDown };
}

export function SlashMenu({ matches, highlighted, setHighlighted, choose }: SlashMenuState) {
  return (
    <div className="md-menu md-menu-slash" role="listbox" aria-label="Skill">
      {matches.map((command, index) => (
        <button
          key={command.id}
          type="button"
          role="option"
          aria-selected={index === highlighted}
          className="md-menu-item"
          data-highlighted={index === highlighted}
          onMouseEnter={() => setHighlighted(index)}
          // mousedown, not click: the text area must not lose the caret first.
          onMouseDown={(event) => {
            event.preventDefault();
            choose(command.name);
          }}
        >
          <span className="md-slash-name">/{command.name}</span>
          <span className="md-menu-detail">{command.description || (command.shared ? "Skill condivisa" : "Tua skill")}</span>
        </button>
      ))}
    </div>
  );
}
