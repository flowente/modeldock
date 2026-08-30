import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaHttpGateway } from "./index.js";

describe("OllamaHttpGateway", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails a pull when Ollama reports an error inside the stream", async () => {
    const gateway = new OllamaHttpGateway("http://127.0.0.1:11434", {
      now: () => new Date("2026-08-29T00:00:00.000Z")
    });

    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(createTextStream('{"status":"pulling manifest"}\n{"error":"pull model manifest: file does not exist"}\n'), {
          status: 200
        })
    );

    await expect(drain(gateway.pullModel({ name: "cszcsz" }))).rejects.toMatchObject({
      code: "OLLAMA_PULL_FAILED",
      message: "pull model manifest: file does not exist"
    });
  });

  it("maps pull progress from Ollama stream events", async () => {
    const gateway = new OllamaHttpGateway("http://127.0.0.1:11434", {
      now: () => new Date("2026-08-29T00:00:00.000Z")
    });

    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(createTextStream('{"status":"downloading","completed":25,"total":100}\n'), {
          status: 200
        })
    );

    await expect(drain(gateway.pullModel({ name: "tinyllama:latest" }))).resolves.toEqual([
      {
        model: "tinyllama:latest",
        status: "downloading",
        completedBytes: 25,
        totalBytes: 100
      }
    ]);
  });
});

async function drain<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];

  for await (const item of items) {
    result.push(item);
  }

  return result;
}

function createTextStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}
