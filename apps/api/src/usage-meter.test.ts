import { describe, expect, it } from "vitest";
import { JsonUsageMeter, StreamUsageMeter } from "./usage-meter.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const text = (pieces: Uint8Array[]) => pieces.map((piece) => decoder.decode(piece)).join("");

const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
const usageEvent = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } })}\n\n`;
const stream = chunk("Cia") + chunk("o") + usageEvent + "data: [DONE]\n\n";

/** Feeds the stream in awkward pieces, the way it arrives over a network. */
function feed(meter: StreamUsageMeter, value: string, size: number) {
  const out: Uint8Array[] = [];
  const bytes = encoder.encode(value);
  for (let index = 0; index < bytes.length; index += size) out.push(...meter.pass(bytes.slice(index, index + size)));
  const { rest, usage } = meter.finish();
  return { output: text([...out, ...rest]), usage };
}

describe("StreamUsageMeter", () => {
  it("counts tokens and leaves the stream unchanged when the caller asked for usage", () => {
    for (const size of [1, 7, 1000]) {
      const { output, usage } = feed(new StreamUsageMeter({ forwardUsageEvent: true }), stream, size);
      expect(output).toBe(stream);
      expect(usage).toEqual({ promptTokens: 12, completionTokens: 7 });
    }
  });

  it("takes out the usage event the caller did not ask for, and still counts", () => {
    const { output, usage } = feed(new StreamUsageMeter({ forwardUsageEvent: false }), stream, 5);
    expect(output).toBe(chunk("Cia") + chunk("o") + "data: [DONE]\n\n");
    expect(usage).toEqual({ promptTokens: 12, completionTokens: 7 });
  });

  it("passes on what it does not understand, and counts zero without a usage event", () => {
    const odd = ": keep-alive\n\ndata: not json\n\n" + chunk("x");
    const { output, usage } = feed(new StreamUsageMeter({ forwardUsageEvent: false }), odd, 3);
    expect(output).toBe(odd);
    expect(usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
});

describe("JsonUsageMeter", () => {
  it("reads usage from a complete answer and passes the bytes through", () => {
    const meter = new JsonUsageMeter();
    const body = JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } });
    const passed = [...meter.pass(encoder.encode(body.slice(0, 10))), ...meter.pass(encoder.encode(body.slice(10)))];
    expect(text(passed)).toBe(body);
    expect(meter.finish().usage).toEqual({ promptTokens: 3, completionTokens: 4 });
  });

  it("counts zero for an answer that is not JSON", () => {
    const meter = new JsonUsageMeter();
    meter.pass(encoder.encode("<html>"));
    expect(meter.finish().usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
});
