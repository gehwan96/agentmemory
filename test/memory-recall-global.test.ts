import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal mock types
type TriggerPayload = { function_id: string; payload: Record<string, unknown> };

function makeSdk(triggerImpl: (p: TriggerPayload) => unknown) {
  const handlers: Record<string, (req: unknown) => Promise<unknown>> = {};
  return {
    registerFunction: (id: string, fn: (req: unknown) => Promise<unknown>) => {
      handlers[id] = fn;
    },
    registerTrigger: vi.fn(),
    trigger: vi.fn().mockImplementation((p: TriggerPayload) => Promise.resolve(triggerImpl(p))),
    _call: (id: string, req: unknown) => handlers[id]?.(req),
  };
}

function makeKv() {
  const store: Record<string, Record<string, unknown>> = {};
  return {
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    set: vi.fn().mockResolvedValue(undefined),
    _store: store,
  };
}

async function buildServer(sdk: ReturnType<typeof makeSdk>, kv: ReturnType<typeof makeKv>) {
  const { registerMcpEndpoints } = await import("../src/mcp/server.js");
  registerMcpEndpoints(sdk as unknown as Parameters<typeof registerMcpEndpoints>[0], kv as unknown as Parameters<typeof registerMcpEndpoints>[1]);
}

describe("memory_recall_global", () => {
  it("returns 400 when query is missing", async () => {
    const sdk = makeSdk(() => ({}));
    const kv = makeKv();
    await buildServer(sdk, kv);

    const res = await sdk._call("mcp::tools::call", {
      body: { name: "memory_recall_global", arguments: {} },
    }) as { status_code: number };
    expect(res.status_code).toBe(400);
  });

  it("calls mem::smart-search without project when projects not specified", async () => {
    const fakeResults = { mode: "compact", results: [{ obsId: "obs1", score: 0.9, sessionId: "s1", title: "T", type: "fact", timestamp: "2025-01-01T00:00:00Z" }] };
    const sdk = makeSdk((p: TriggerPayload) => {
      if (p.function_id === "mem::smart-search") return fakeResults;
      return {};
    });
    const kv = makeKv();
    await buildServer(sdk, kv);

    const res = await sdk._call("mcp::tools::call", {
      body: { name: "memory_recall_global", arguments: { query: "test" } },
    }) as { status_code: number; body: { content: Array<{ text: string }> } };

    expect(res.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        function_id: "mem::smart-search",
        payload: expect.not.objectContaining({ project: expect.anything() }),
      }),
    );
  });

  it("calls mem::smart-search once per project and merges results", async () => {
    const resultA = { mode: "compact", results: [
      { obsId: "obs1", score: 0.9, sessionId: "s1", title: "From A", type: "fact", timestamp: "2025-01-01T00:00:00Z" },
      { obsId: "shared", score: 0.7, sessionId: "s2", title: "Shared", type: "fact", timestamp: "2025-01-01T00:00:00Z" },
    ]};
    const resultB = { mode: "compact", results: [
      { obsId: "obs2", score: 0.8, sessionId: "s3", title: "From B", type: "fact", timestamp: "2025-01-01T00:00:00Z" },
      { obsId: "shared", score: 0.6, sessionId: "s2", title: "Shared", type: "fact", timestamp: "2025-01-01T00:00:00Z" },
    ]};

    let callCount = 0;
    const sdk = makeSdk((p: TriggerPayload) => {
      if (p.function_id === "mem::smart-search") {
        callCount++;
        return p.payload.project === "A" ? resultA : resultB;
      }
      return {};
    });
    const kv = makeKv();
    await buildServer(sdk, kv);

    const res = await sdk._call("mcp::tools::call", {
      body: { name: "memory_recall_global", arguments: { query: "test", projects: "A,B" } },
    }) as { status_code: number; body: { content: Array<{ text: string }> } };

    expect(res.status_code).toBe(200);
    expect(callCount).toBe(2);

    const body = JSON.parse(res.body.content[0].text);
    expect(body.results).toHaveLength(3); // obs1, obs2, shared (deduplicated)
    // shared from A has higher score (0.9) so it should win
    const shared = body.results.find((r: { obsId: string }) => r.obsId === "shared");
    expect(shared?.score).toBe(0.7); // A's score was 0.7
  });

  it("respects limit and returns results sorted by score descending", async () => {
    const resultA = { mode: "compact", results: [
      { obsId: "low", score: 0.3, sessionId: "s1", title: "Low", type: "fact", timestamp: "2025-01-01T00:00:00Z" },
      { obsId: "high", score: 0.9, sessionId: "s2", title: "High", type: "fact", timestamp: "2025-01-01T00:00:00Z" },
    ]};
    const sdk = makeSdk((p: TriggerPayload) => {
      if (p.function_id === "mem::smart-search") return resultA;
      return {};
    });
    const kv = makeKv();
    await buildServer(sdk, kv);

    const res = await sdk._call("mcp::tools::call", {
      body: { name: "memory_recall_global", arguments: { query: "test", limit: 1, projects: "A" } },
    }) as { status_code: number; body: { content: Array<{ text: string }> } };

    expect(res.status_code).toBe(200);
    const body = JSON.parse(res.body.content[0].text);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].obsId).toBe("high");
  });
});
