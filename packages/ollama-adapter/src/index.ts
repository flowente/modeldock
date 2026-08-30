import type {
  ComponentHealth,
  InferenceProbe,
  Model,
  ModelPullProgress,
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
  }>;
}

export class OllamaHttpGateway implements OllamaGateway {
  private readonly baseUrl: string;
  private readonly clock: Clock;

  public constructor(baseUrl: string, clock: Clock) {
    this.baseUrl = baseUrl;
    this.clock = clock;
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
      expiresAt: model.expires_at
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
