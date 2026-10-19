import type {
  ChatChunk,
  ChatInput,
  ComponentHealth,
  InferenceProbe,
  Model,
  ModelPullProgress,
  OpenAiForwardInput,
  OpenAiForwardResponse,
  ModelRuntimeInput,
  OllamaGateway,
  PullModelInput,
  RunningModel
} from "@modeldock/core";
import { createComponentHealth, ModelDockError, type Clock } from "@modeldock/core";

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    size?: number;
    modified_at?: string;
  }>;
}

interface OllamaPsResponse {
  models?: Array<{
    name?: string;
    size?: number;
    expires_at?: string;
    context_length?: number;
  }>;
}

/**
 * How long a model stays in memory after its last use. Ollama's own default is five minutes,
 * and reloading a big model costs about a minute here: half an hour keeps the one in use warm.
 */
export const DEFAULT_KEEP_ALIVE = "30m";

export class OllamaHttpGateway implements OllamaGateway {
  private readonly baseUrl: string;
  private readonly clock: Clock;
  private readonly keepAlive: string;

  public constructor(baseUrl: string, clock: Clock, keepAlive: string = DEFAULT_KEEP_ALIVE) {
    this.baseUrl = baseUrl;
    this.clock = clock;
    this.keepAlive = keepAlive;
  }

  public async getHealth(): Promise<ComponentHealth> {
    try {
      const response = await fetch(this.url("/api/version"));

      if (!response.ok) {
        return createComponentHealth(
          {
            name: "ollama",
            status: "unavailable",
            message: `Ollama returned HTTP ${response.status}`
          },
          this.clock
        );
      }

      const body = (await response.json()) as { version?: string };
      return createComponentHealth(
        {
          name: "ollama",
          status: "available",
          message: "Ollama is reachable",
          details: { version: body.version ?? "unknown" }
        },
        this.clock
      );
    } catch (error) {
      return createComponentHealth(
        {
          name: "ollama",
          status: "unavailable",
          message: "Ollama is not reachable",
          details: { baseUrl: this.baseUrl, error: error instanceof Error ? error.message : String(error) }
        },
        this.clock
      );
    }
  }

  public async listLocalModels(): Promise<Model[]> {
    const body = await this.getJson<OllamaTagsResponse>("/api/tags");
    const running = new Set((await this.listRunningModels()).map((model) => model.name));

    return (body.models ?? []).map((model) => {
      const name = model.name ?? "unknown";
      const tag = name.includes(":") ? name.split(":").at(-1) ?? "latest" : "latest";

      return {
        name,
        tag,
        sizeBytes: model.size ?? 0,
        modifiedAt: model.modified_at,
        running: running.has(name)
      };
    });
  }

  public async listRunningModels(): Promise<RunningModel[]> {
    const body = await this.getJson<OllamaPsResponse>("/api/ps");

    return (body.models ?? []).map((model) => ({
      name: model.name ?? "unknown",
      sizeBytes: model.size,
      expiresAt: model.expires_at,
      ...(model.context_length ? { contextLength: model.context_length } : {})
    }));
  }

  public async loadModel(input: ModelRuntimeInput): Promise<void> {
    await this.setModelKeepAlive(input.model, -1, "loadModel");
  }

  public async unloadModel(input: ModelRuntimeInput): Promise<void> {
    await this.setModelKeepAlive(input.model, 0, "unloadModel");
  }

  public async *pullModel(input: PullModelInput): AsyncIterable<ModelPullProgress> {
    const response = await fetch(this.url("/api/pull"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: input.name })
    });

    if (!response.ok || !response.body) {
      throw this.toDependencyError("pullModel", `Ollama pull failed with HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        yield this.parsePullProgressLine(input.name, line);
      }
    }

    if (buffer.trim()) {
      yield this.parsePullProgressLine(input.name, buffer);
    }
  }

  public async deleteModel(name: string): Promise<void> {
    const response = await fetch(this.url("/api/delete"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: name })
    });

    if (!response.ok) {
      throw this.toDependencyError("deleteModel", `Ollama delete failed with HTTP ${response.status}`);
    }
  }

  public async probeModel(input: { model: string; prompt: string }): Promise<InferenceProbe> {
    const started = this.clock.now().getTime();
    const response = await fetch(this.url("/api/generate"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        stream: false,
        options: { num_predict: 64 }
      })
    });

    if (!response.ok) {
      throw this.toDependencyError("probeModel", `Ollama probe failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as { response?: string; eval_count?: number };

    return {
      model: input.model,
      output: body.response ?? "",
      durationMs: Math.max(0, this.clock.now().getTime() - started),
      tokenCount: body.eval_count
    };
  }

  public async getModelCapabilities(name: string): Promise<string[]> {
    const response = await fetch(this.url("/api/show"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: name })
    });

    if (!response.ok) {
      throw this.toDependencyError("getModelCapabilities", `Ollama show failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as { capabilities?: unknown };
    return Array.isArray(body.capabilities) ? body.capabilities.map(String) : [];
  }

  public async *chat(input: ChatInput): AsyncIterable<ChatChunk> {
    const response = await fetch(this.url("/api/chat"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: input.model, messages: input.messages, stream: true, keep_alive: this.keepAlive }),
      ...(input.signal ? { signal: input.signal } : {})
    });

    if (!response.ok || !response.body) {
      throw this.toDependencyError("chat", `Ollama chat failed with HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const chunk = parseChatLine(line);

          if (chunk) {
            yield chunk;
          }
        }
      }

      const last = parseChatLine(buffer);

      if (last) {
        yield last;
      }
    } finally {
      // Stopping early (the user pressed stop) must also stop Ollama generating.
      await reader.cancel().catch(() => undefined);
    }
  }

  public async openAi(input: OpenAiForwardInput): Promise<OpenAiForwardResponse> {
    let response: Response;
    try {
      response = await fetch(this.url(input.endpoint), {
        method: "POST",
        headers: { "content-type": "application/json" },
        // A caller that sets its own keep_alive keeps it.
        body: JSON.stringify({ keep_alive: this.keepAlive, ...input.body }),
        ...(input.signal ? { signal: input.signal } : {})
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new ModelDockError({
        code: "DEPENDENCY_UNAVAILABLE",
        module: "ollama-adapter",
        message: "Ollama is not reachable.",
        suggestion: "Start Ollama and retry.",
        httpStatus: 502
      });
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      body: response.body ?? emptyBody()
    };
  }

  public async warmModel(name: string): Promise<{ loadMs: number }> {
    const response = await fetch(this.url("/api/generate"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // An empty prompt loads the model and answers nothing.
      body: JSON.stringify({ model: name, prompt: "", stream: false, keep_alive: this.keepAlive })
    });
    if (!response.ok) {
      throw this.toDependencyError("warmModel", `Ollama could not load ${name} (HTTP ${response.status})`);
    }
    const body = (await response.json()) as { load_duration?: number };
    return { loadMs: Math.round((body.load_duration ?? 0) / 1e6) };
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(this.url(path));

    if (!response.ok) {
      throw this.toDependencyError(path, `Ollama returned HTTP ${response.status}`);
    }

    return (await response.json()) as T;
  }

  private async setModelKeepAlive(model: string, keepAlive: number, action: string): Promise<void> {
    const response = await fetch(this.url("/api/generate"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "",
        stream: false,
        keep_alive: keepAlive
      })
    });

    if (!response.ok) {
      throw this.toDependencyError(action, `Ollama ${action} failed with HTTP ${response.status}`);
    }

    await response.arrayBuffer();
  }

  private parsePullProgressLine(model: string, line: string): ModelPullProgress {
    const payload = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };

    if (payload.error) {
      throw new ModelDockError({
        code: "OLLAMA_PULL_FAILED",
        module: "ollama-adapter",
        message: payload.error,
        suggestion: "Check the model name on Ollama Search and retry."
      });
    }

    return {
      model,
      status: payload.status ?? "unknown",
      completedBytes: payload.completed,
      totalBytes: payload.total
    };
  }

  private url(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  private toDependencyError(action: string, message: string): ModelDockError {
    return new ModelDockError({
      code: "UNKNOWN_DEPENDENCY_ERROR",
      module: "ollama-adapter",
      message,
      suggestion: `Check Ollama and retry ${action}.`
    });
  }
}

async function* emptyBody(): AsyncIterable<Uint8Array> {}

function parseChatLine(line: string): ChatChunk | undefined {
  if (!line.trim()) {
    return undefined;
  }

  const body = JSON.parse(line) as {
    message?: { content?: string; thinking?: string };
    done?: boolean;
    error?: string;
    load_duration?: number;
    prompt_eval_count?: number;
  };

  if (body.error) {
    throw new ModelDockError({ code: "OLLAMA_CHAT_FAILED", module: "ollama-adapter", message: body.error, httpStatus: 502 });
  }

  return {
    content: body.message?.content ?? "",
    done: body.done === true,
    ...(body.message?.thinking ? { thinking: true } : {}),
    ...(body.done && body.load_duration ? { loadMs: Math.round(body.load_duration / 1e6) } : {}),
    ...(body.done && body.prompt_eval_count ? { promptTokens: body.prompt_eval_count } : {})
  };
}
