import { useState } from "react";

export function useClipboard(timeoutMs = 1600) {
  const [copied, setCopied] = useState(false);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), timeoutMs);
    } catch {
      setCopied(false);
    }
  }

  return {
    copied,
    copy
  };
}
