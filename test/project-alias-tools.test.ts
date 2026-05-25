import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

function makeSdk() {
  type TriggerPayload = { function_id: string; payload: Record<string, unknown> };
  const handlers: Record<string, (req: unknown) => Promise<unknown>> = {};
  return {
    registerFunction: (id: string, fn: (req: unknown) => Promise<unknown>) => {
      handlers[id] = fn;
    },
    registerTrigger: vi.fn(),
    trigger: vi.fn().mockResolvedValue({}),
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
  tmpDir = mkdtempSync(join(tmpdir(), "agentmemory-alias-tools-test-"));
  process.env["AGENTMEMORY_ALIASES_FILE"] = join(tmpDir, "aliases.json");
});

afterEach(async () => {
  delete process.env["AGENTMEMORY_ALIASES_FILE"];
  const { invalidateAliasCache } = await import("../src/mcp/project-aliases.js");
  invalidateAliasCache();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("memory_project_alias_list", () => {
  it("returns empty aliases when no file exists", async () => {
    const sdk = makeSdk();
    const kv = makeKv();
    await buildServer(sdk, kv);

    const res = (await sdk._call("mcp::tools::call", {
      body: { name: "memory_project_alias_list", arguments: {} },
    })) as { status_code: number; body: { content: Array<{ text: string }> } };

    expect(res.status_code).toBe(200);
    const body = JSON.parse(res.body.content[0].text);
    expect(body.aliases).toEqual([]);
  });
});

describe("memory_project_alias_add", () => {
  it("returns 400 when canonical is missing", async () => {
    const sdk = makeSdk();
    const kv = makeKv();
    await buildServer(sdk, kv);

    const res = (await sdk._call("mcp::tools::call", {
      body: { name: "memory_project_alias_add", arguments: { aliases: ["short"] } },
    })) as { status_code: number };
    expect(res.status_code).toBe(400);
  });

  it("adds a new mapping and persists it", async () => {
    const sdk = makeSdk();
    const kv = makeKv();
    await buildServer(sdk, kv);

    const addRes = (await sdk._call("mcp::tools::call", {
      body: {
        name: "memory_project_alias_add",
        arguments: { canonical: "/Users/me/project-a", aliases: ["E-mail"] },
      },
    })) as { status_code: number; body: { content: Array<{ text: string }> } };
    expect(addRes.status_code).toBe(200);

    const { invalidateAliasCache, loadProjectAliases } = await import("../src/mcp/project-aliases.js");
    invalidateAliasCache();
    const aliases = loadProjectAliases();
    expect(aliases).toHaveLength(1);
    expect(aliases[0].canonical).toBe("/Users/me/project-a");
    expect(aliases[0].aliases).toContain("E-mail");
  });

  it("merges aliases when canonical already exists", async () => {
    const sdk = makeSdk();
    const kv = makeKv();
    await buildServer(sdk, kv);

    await sdk._call("mcp::tools::call", {
      body: {
        name: "memory_project_alias_add",
        arguments: { canonical: "/Users/me/project-a", aliases: ["E-mail"] },
      },
    });
    await sdk._call("mcp::tools::call", {
      body: {
        name: "memory_project_alias_add",
        arguments: { canonical: "/Users/me/project-a", aliases: ["email-svc"] },
      },
    });

    const { invalidateAliasCache, loadProjectAliases } = await import("../src/mcp/project-aliases.js");
    invalidateAliasCache();
    const aliases = loadProjectAliases();
    expect(aliases).toHaveLength(1);
    expect(aliases[0].aliases).toContain("E-mail");
    expect(aliases[0].aliases).toContain("email-svc");
  });
});

describe("memory_project_alias_remove", () => {
  it("returns 400 when neither canonical nor alias is provided", async () => {
    const sdk = makeSdk();
    const kv = makeKv();
    await buildServer(sdk, kv);

    const res = (await sdk._call("mcp::tools::call", {
      body: { name: "memory_project_alias_remove", arguments: {} },
    })) as { status_code: number };
    expect(res.status_code).toBe(400);
  });

  it("removes entire entry when canonical is provided", async () => {
    const sdk = makeSdk();
    const kv = makeKv();
    await buildServer(sdk, kv);

    await sdk._call("mcp::tools::call", {
      body: {
        name: "memory_project_alias_add",
        arguments: { canonical: "/Users/me/project-a", aliases: ["E-mail"] },
      },
    });
    await sdk._call("mcp::tools::call", {
      body: {
        name: "memory_project_alias_remove",
        arguments: { canonical: "/Users/me/project-a" },
      },
    });

    const { invalidateAliasCache, loadProjectAliases } = await import("../src/mcp/project-aliases.js");
    invalidateAliasCache();
    expect(loadProjectAliases()).toHaveLength(0);
  });

  it("removes only a specific alias when alias param is provided", async () => {
    const sdk = makeSdk();
    const kv = makeKv();
    await buildServer(sdk, kv);

    await sdk._call("mcp::tools::call", {
      body: {
        name: "memory_project_alias_add",
        arguments: { canonical: "/Users/me/project-a", aliases: ["E-mail", "email-svc"] },
      },
    });
    await sdk._call("mcp::tools::call", {
      body: {
        name: "memory_project_alias_remove",
        arguments: { alias: "E-mail" },
      },
    });

    const { invalidateAliasCache, loadProjectAliases } = await import("../src/mcp/project-aliases.js");
    invalidateAliasCache();
    const aliases = loadProjectAliases();
    expect(aliases[0].aliases).not.toContain("E-mail");
    expect(aliases[0].aliases).toContain("email-svc");
  });
});
