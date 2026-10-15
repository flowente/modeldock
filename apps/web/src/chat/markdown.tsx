import { Check, Copy } from "lucide-react";
import { isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Writes to the clipboard. `navigator.clipboard` exists only on secure pages (https or
 * localhost); a phone opening ModelDock over the local network gets the older fallback.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the fallback
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  return copied;
}

export function CopyButton({ text, label = "Copia", compact = false }: { text: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    if (await copyText(text)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };
  const Icon = copied ? Check : Copy;
  return (
    <button type="button" className="md-ghost" onClick={onClick} aria-label={compact ? (copied ? "Copiato" : label) : undefined}>
      <Icon size={compact ? 16 : 14} aria-hidden="true" />
      {compact ? null : copied ? "Copiato" : label}
    </button>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

const components: Components = {
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const className = isValidElement<{ className?: string }>(child) ? (child.props.className ?? "") : "";
    const language = /language-([\w+-]+)/.exec(className)?.[1] ?? "testo";
    const code = textOf(children).replace(/\n$/, "");
    return (
      <div className="md-code">
        <div className="md-code-header">
          {language}
          <CopyButton text={code} />
        </div>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  },
  table({ children }) {
    return (
      <div className="md-table-scroll">
        <table>{children}</table>
      </div>
    );
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
};

/** Replies are rendered as Markdown. Raw HTML in a reply is shown as text, never executed. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
