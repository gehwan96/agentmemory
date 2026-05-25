import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  registerSearchFunction,
  getSearchIndex,
  rebuildIndex,
} from "../src/functions/search.js";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { KV } from "../src/state/schema.js";
import { invalidateAliasCache } from "../src/mcp/project-aliases.js";
import type { Memory, HybridSearchResult, CompressedObservation, CompactSearchResult } from "../src/types.js";

let tmpDir: string;

function makeMemory(id: string, title: string, project: string | undefined): Memory {
  return {
    id,
    createdAt: "2026-05-25T00:00:00Z",
    updatedAt: "2026-05-25T00:00:00Z",
    type: "fact",
    title,
    content: `Content for ${title}`,
    concepts: [title.toLowerCase()],
    files: [],
    sessionIds: [],
    strength: 7,
    version: 1,
    isLatest: true,
    project,
  };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentmemory-alias-search-test-"));
  const aliasesFile = join(tmpDir, "aliases.json");
  // Map "E-mail" → "/Users/nhn/project/nc-notification-email"
  writeFileSync(aliasesFile, JSON.stringify({
    aliases: [
      {
        canonical: "/Users/nhn/project/nc-notification-email",
        aliases: ["E-mail", "email-service"],
      },
    ],
  }));
  process.env["AGENTMEMORY_ALIASES_FILE"] = aliasesFile;
  invalidateAliasCache();
  getSearchIndex().clear();
});

afterEach(() => {
  delete process.env["AGENTMEMORY_ALIASES_FILE"];
  invalidateAliasCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────
// mem::search — alias matching
// ─────────────────────────────────────────────────────────────────────
describe("mem::search — alias matching", () => {
  it("finds memories tagged with short name when searching by canonical", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerSearchFunction(sdk as never, kv as never);

    // memShort was stored under the old short name "E-mail"
    const memShort = makeMemory("mem_short", "Email service JWT caching", "E-mail");
    // memCanon was stored under the full canonical path
    const memCanon = makeMemory("mem_canon", "Email service rate limiting", "/Users/nhn/project/nc-notification-email");
    // memOther belongs to a completely different project
    const memOther = makeMemory("mem_other", "Email service migration notes", "other-project");

    await kv.set(KV.memories, memShort.id, memShort);
    await kv.set(KV.memories, memCanon.id, memCanon);
    await kv.set(KV.memories, memOther.id, memOther);
    await rebuildIndex(kv as never);

    // Search with canonical path — should find both "E-mail" and canonical entries
    const result = (await sdk.trigger("mem::search", {
      query: "Email service",
      project: "/Users/nhn/project/nc-notification-email",
      format: "compact",
    })) as { results: Array<{ obsId: string }> };

    const ids = result.results.map((r) => r.obsId);
    expect(ids).toContain("mem_short");   // tagged "E-mail" — alias match
    expect(ids).toContain("mem_canon");   // tagged canonical — direct match
    expect(ids).not.toContain("mem_other"); // different project
  });

  it("finds memories tagged with canonical when searching by alias", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerSearchFunction(sdk as never, kv as never);

    const memCanon = makeMemory("mem_canon2", "Email auth tokens", "/Users/nhn/project/nc-notification-email");
    await kv.set(KV.memories, memCanon.id, memCanon);
    await rebuildIndex(kv as never);

    // Search with alias "E-mail" — should find canonical-tagged entry
    const result = (await sdk.trigger("mem::search", {
      query: "Email auth",
      project: "E-mail",
      format: "compact",
    })) as { results: Array<{ obsId: string }> };

    expect(result.results.map((r) => r.obsId)).toContain("mem_canon2");
  });
});

// ─────────────────────────────────────────────────────────────────────
// mem::smart-search — alias matching
// ─────────────────────────────────────────────────────────────────────
describe("mem::smart-search — alias matching", () => {
  function makeObs(id: string, title: string, sessionId = "synthetic_memory"): CompressedObservation {
    return {
      id,
      sessionId,
      timestamp: "2026-05-25T00:00:00Z",
      type: "fact",
      title,
      facts: [],
      narrative: title,
      concepts: [],
      files: [],
      importance: 7,
    };
  }

  function makeHybrid(obs: CompressedObservation, sessionId: string): HybridSearchResult {
    return { observation: obs, bm25Score: 0.8, vectorScore: 0, graphScore: 0, combinedScore: 0.8, sessionId };
  }

  it("includes alias-tagged memories when filtering by canonical", async () => {
    const sdk = mockSdk();
    const kv = mockKV();

    const memShort = makeMemory("ss_mem_short", "JWT caching in email", "E-mail");
    const memCanon = makeMemory("ss_mem_canon", "Rate limiting in email", "/Users/nhn/project/nc-notification-email");
    const memOther = makeMemory("ss_mem_other", "Unrelated project", "unrelated");

    await kv.set(KV.memories, memShort.id, memShort);
    await kv.set(KV.memories, memCanon.id, memCanon);
    await kv.set(KV.memories, memOther.id, memOther);

    const hybridResults: HybridSearchResult[] = [
      makeHybrid(makeObs("ss_mem_short", "JWT caching in email"), "synthetic_memory"),
      makeHybrid(makeObs("ss_mem_canon", "Rate limiting in email"), "synthetic_memory"),
      makeHybrid(makeObs("ss_mem_other", "Unrelated project"), "synthetic_memory"),
    ];
    const searchFn = async () => hybridResults;
    registerSmartSearchFunction(sdk as never, kv as never, searchFn);

    const result = (await sdk.trigger("mem::smart-search", {
      query: "email",
      project: "/Users/nhn/project/nc-notification-email",
    })) as { mode: string; results: CompactSearchResult[] };

    const ids = result.results.map((r) => r.obsId);
    expect(ids).toContain("ss_mem_short");  // "E-mail" alias matches canonical
    expect(ids).toContain("ss_mem_canon");  // canonical direct match
    expect(ids).not.toContain("ss_mem_other"); // different project
  });
});
