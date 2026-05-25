import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

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
  return {
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    set: vi.fn().mockResolvedValue(undefined),
  };
}

async function buildServer(sdk: ReturnType<typeof makeSdk>, kv: ReturnType<typeof makeKv>) {
  const { registerMcpEndpoints } = await import("../src/mcp/server.js");
  registerMcpEndpoints(
    sdk as unknown as Parameters<typeof registerMcpEndpoints>[0],
    kv as unknown as Parameters<typeof registerMcpEndpoints>[1],
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentmemory-global-alias-test-"));
  const aliasesFile = join(tmpDir, "aliases.json");
  writeFileSync(aliasesFile, JSON.stringify({
    aliases: [
      {
        canonical: "/Users/nhn/project/nc-notification-email",
        aliases: ["E-mail", "email-service"],
      },
    ],
  }));
  process.env["AGENTMEMORY_ALIASES_FILE"] = aliasesFile;
});

afterEach(async () => {
  delete process.env["AGENTMEMORY_ALIASES_FILE"];
  const { invalidateAliasCache } = await import("../src/mcp/project-aliases.js");
  invalidateAliasCache();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("memory_recall_global — alias normalization", () => {
  it("normalizes alias to canonical before passing to mem::smart-search", async () => {
    const capturedProjects: string[] = [];

    const sdk = makeSdk((p: TriggerPayload) => {
      if (p.function_id === "mem::smart-search" && p.payload.project) {
        capturedProjects.push(p.payload.project as string);
      }
      return { mode: "compact", results: [] };
    });
    const kv = makeKv();
    await buildServer(sdk, kv);

    await sdk._call("mcp::tools::call", {
      body: {
        name: "memory_recall_global",
        arguments: { query: "test", projects: "E-mail" },
      },
    });

    // "E-mail" should have been normalized to its canonical path before being passed to smart-search
    expect(capturedProjects).toContain("/Users/nhn/project/nc-notification-email");
    expect(capturedProjects).not.toContain("E-mail");
  });

  it("passes canonical name through unchanged", async () => {
    const capturedProjects: string[] = [];

    const sdk = makeSdk((p: TriggerPayload) => {
      if (p.function_id === "mem::smart-search" && p.payload.project) {
        capturedProjects.push(p.payload.project as string);
      }
      return { mode: "compact", results: [] };
    });
    const kv = makeKv();
    await buildServer(sdk, kv);

    await sdk._call("mcp::tools::call", {
      body: {
        name: "memory_recall_global",
        arguments: { query: "test", projects: "/Users/nhn/project/nc-notification-email" },
      },
    });

    expect(capturedProjects).toContain("/Users/nhn/project/nc-notification-email");
  });

  it("normalizes multiple projects including aliases", async () => {
    const capturedProjects: string[] = [];

    const sdk = makeSdk((p: TriggerPayload) => {
      if (p.function_id === "mem::smart-search" && p.payload.project) {
        capturedProjects.push(p.payload.project as string);
      }
      return { mode: "compact", results: [] };
    });
    const kv = makeKv();
    await buildServer(sdk, kv);

    await sdk._call("mcp::tools::call", {
      body: {
        name: "memory_recall_global",
        arguments: { query: "test", projects: "E-mail,/Users/nhn/project/doridesk" },
      },
    });

    // E-mail → canonical; /Users/nhn/project/doridesk → unchanged (no alias mapping)
    expect(capturedProjects).toContain("/Users/nhn/project/nc-notification-email");
    expect(capturedProjects).toContain("/Users/nhn/project/doridesk");
    expect(capturedProjects).not.toContain("E-mail");
  });
});
