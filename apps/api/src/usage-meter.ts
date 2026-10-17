/**
 * Reads the token counts out of an OpenAI-style answer while it passes through, without
 * holding up a stream: server-sent events go out one by one as soon as they are complete.
 */
export interface UsageCount {
  promptTokens: number;
  completionTokens: number;
}

/** A JSON answer (chat without streaming, embeddings): read once it is all there. */
export class JsonUsageMeter {
  private readonly parts: Uint8Array[] = [];
  private size = 0;
  /** Past this, stop keeping a copy: the answer still goes through, only the count is lost. */
  private static readonly MAX_BYTES = 64 * 1024 * 1024;

  public pass(chunk: Uint8Array): Uint8Array[] {
    if (this.size <= JsonUsageMeter.MAX_BYTES) {
      this.parts.push(chunk);
      this.size += chunk.byteLength;
    }
    return [chunk];
  }

  public finish(): { rest: Uint8Array[]; usage: UsageCount } {
    if (this.size > JsonUsageMeter.MAX_BYTES) return { rest: [], usage: none() };
    try {
      return { rest: [], usage: readUsage(JSON.parse(Buffer.concat(this.parts).toString("utf8"))) };
    } catch {
      return { rest: [], usage: none() };
    }
  }
}

/**
 * A streamed chat answer. ModelDock always asks Ollama for the usage event at the end; if the
 * caller did not ask for it, that event is taken out so they get exactly what OpenAI would send.
 */
export class StreamUsageMeter {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly forwardUsageEvent: boolean;
  private buffer = "";
  private usage = none();

  public constructor(options: { forwardUsageEvent: boolean }) {
    this.forwardUsageEvent = options.forwardUsageEvent;
  }

  public pass(chunk: Uint8Array): Uint8Array[] {
    this.buffer += this.decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    const events = this.buffer.split("\n\n");
    this.buffer = events.pop() ?? "";
    return events.flatMap((event) => this.event(event));
  }

  public finish(): { rest: Uint8Array[]; usage: UsageCount } {
    this.buffer += this.decoder.decode();
    const rest = this.buffer.trim() ? this.event(this.buffer) : [];
    this.buffer = "";
    return { rest, usage: this.usage };
  }

  private event(event: string): Uint8Array[] {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data && data !== "[DONE]") {
      try {
        const payload = JSON.parse(data) as { usage?: unknown; choices?: unknown };
        if (payload.usage) {
          this.usage = readUsage(payload);
          const onlyUsage = Array.isArray(payload.choices) && payload.choices.length === 0;
          if (onlyUsage && !this.forwardUsageEvent) return [];
        }
      } catch {
        // Not JSON: pass it on untouched, it is not ours to judge.
      }
    }
    return [this.encoder.encode(`${event}\n\n`)];
  }
}

function readUsage(payload: unknown): UsageCount {
  const usage = (payload as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  return {
    promptTokens: toCount(usage?.prompt_tokens),
    completionTokens: toCount(usage?.completion_tokens)
  };
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function none(): UsageCount {
  return { promptTokens: 0, completionTokens: 0 };
}
