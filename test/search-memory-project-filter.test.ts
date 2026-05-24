import { beforeEach, describe, it, expect, vi } from "vitest";

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
import type { Memory, CompactSearchResult, HybridSearchResult, CompressedObservation } from "../src/types.js";

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

function makeMemory(overrides: Partial<Memory> & { id: string; title: string; content: string }): Memory {
  return {
    id: overrides.id,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    type: "fact",
    title: overrides.title,
    content: overrides.content,
    concepts: overrides.concepts ?? [],
    files: overrides.files ?? [],
    sessionIds: [],
    strength: 7,
    version: 1,
    isLatest: true,
    project: overrides.project,
  };
}

// ────────────────────────────────────────────────────────────
// mem::search — project filter with Memory.project
// ────────────────────────────────────────────────────────────
describe("mem::search — Memory.project direct filter", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerSearchFunction(sdk as never, kv as never);
    // Always start from a clean BM25 index
    getSearchIndex().clear();
  });

  it("returns mem::remember entries matching the project filter", async () => {
    const memA = makeMemory({
      id: "mem_a",
      title: "GraphQL schema design",
      content: "Design the GraphQL schema for the API",
      project: "api-project",
    });
    const memB = makeMemory({
      id: "mem_b",
      title: "GraphQL resolver optimizations",
      content: "Optimize GraphQL resolvers for performance",
      project: "other-project",
    });

    await kv.set(KV.memories, memA.id, memA);
    await kv.set(KV.memories, memB.id, memB);
    await rebuildIndex(kv as never);

    const result = (await sdk.trigger("mem::search", {
      query: "GraphQL",
      project: "api-project",
      format: "compact",
    })) as { results: Array<{ obsId: string }> };

    const ids = result.results.map((r) => r.obsId);
    expect(ids).toContain("mem_a");
    expect(ids).not.toContain("mem_b");
  });

  it("returns global (undefined project) mem::remember entries under any project filter", async () => {
    const memGlobal = makeMemory({
      id: "mem_global",
      title: "Global deployment checklist",
      content: "Checklist for deploying any project to production",
      project: undefined,
    });
    const memSpecific = makeMemory({
      id: "mem_specific",
      title: "Specific deployment notes",
      content: "Notes specific to deployment in project-alpha only",
      project: "project-beta",
    });

    await kv.set(KV.memories, memGlobal.id, memGlobal);
    await kv.set(KV.memories, memSpecific.id, memSpecific);
    await rebuildIndex(kv as never);

    const result = (await sdk.trigger("mem::search", {
      query: "deployment checklist",
      project: "project-alpha",
      format: "compact",
    })) as { results: Array<{ obsId: string }> };

    const ids = result.results.map((r) => r.obsId);
    expect(ids).toContain("mem_global");
    expect(ids).not.toContain("mem_specific");
  });

  it("excludes mem::remember entries from other projects", async () => {
    const memFoo = makeMemory({
      id: "mem_foo",
      title: "Database migration strategy",
      content: "Strategy for migrating the database schema safely",
      project: "project-foo",
    });
    const memBar = makeMemory({
      id: "mem_bar",
      title: "Database backup procedure",
      content: "Procedure for backing up database regularly",
      project: "project-bar",
    });

    await kv.set(KV.memories, memFoo.id, memFoo);
    await kv.set(KV.memories, memBar.id, memBar);
    await rebuildIndex(kv as never);

    const resultFoo = (await sdk.trigger("mem::search", {
      query: "database",
      project: "project-foo",
      format: "compact",
    })) as { results: Array<{ obsId: string }> };

    const idsFoo = resultFoo.results.map((r) => r.obsId);
    expect(idsFoo).toContain("mem_foo");
    expect(idsFoo).not.toContain("mem_bar");
  });
});

// ────────────────────────────────────────────────────────────
// mem::smart-search — project filter with Memory.project
// ────────────────────────────────────────────────────────────
describe("mem::smart-search — Memory.project direct filter", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
  });

  function makeObs(
    id: string,
    title: string,
    sessionId = "synthetic_memory",
  ): CompressedObservation {
    return {
      id,
      sessionId,
      timestamp: "2026-03-01T00:00:00Z",
      type: "decision",
      title,
      facts: [],
      narrative: title,
      concepts: [],
      files: [],
      importance: 7,
    };
  }

  function makeHybrid(obs: CompressedObservation, sessionId: string): HybridSearchResult {
    return {
      observation: obs,
      bm25Score: 0.8,
      vectorScore: 0,
      graphScore: 0,
      combinedScore: 0.8,
      sessionId,
    };
  }

  it("filters out mem::remember entries not matching the project", async () => {
    const memMatch = makeMemory({
      id: "mem_match",
      title: "Matching memory",
      content: "This memory belongs to target-project",
      project: "target-project",
    });
    const memNoMatch = makeMemory({
      id: "mem_no_match",
      title: "Non-matching memory",
      content: "This memory belongs to other-project",
      project: "other-project",
    });

    await kv.set(KV.memories, memMatch.id, memMatch);
    await kv.set(KV.memories, memNoMatch.id, memNoMatch);

    const obsMatch = makeObs("mem_match", "Matching memory");
    const obsNoMatch = makeObs("mem_no_match", "Non-matching memory");

    const searchResults: HybridSearchResult[] = [
      makeHybrid(obsMatch, "synthetic_memory"),
      makeHybrid(obsNoMatch, "synthetic_memory"),
    ];

    const searchFn = async (_query: string, _limit: number) => searchResults;
    registerSmartSearchFunction(sdk as never, kv as never, searchFn);

    const result = (await sdk.trigger("mem::smart-search", {
      query: "memory",
      project: "target-project",
    })) as { mode: string; results: CompactSearchResult[] };

    expect(result.mode).toBe("compact");
    const ids = result.results.map((r) => r.obsId);
    expect(ids).toContain("mem_match");
    expect(ids).not.toContain("mem_no_match");
  });

  it("passes global mem::remember entries (undefined project) through any project filter", async () => {
    const memGlobal = makeMemory({
      id: "mem_global_ss",
      title: "Global smart search memory",
      content: "Applicable to all projects",
      project: undefined,
    });

    await kv.set(KV.memories, memGlobal.id, memGlobal);

    const obsGlobal = makeObs("mem_global_ss", "Global smart search memory");

    const searchResults: HybridSearchResult[] = [
      makeHybrid(obsGlobal, "synthetic_memory"),
    ];

    const searchFn = async (_query: string, _limit: number) => searchResults;
    registerSmartSearchFunction(sdk as never, kv as never, searchFn);

    const result = (await sdk.trigger("mem::smart-search", {
      query: "global",
      project: "any-project",
    })) as { mode: string; results: CompactSearchResult[] };

    expect(result.mode).toBe("compact");
    expect(result.results.map((r) => r.obsId)).toContain("mem_global_ss");
  });

  it("filters session-backed observations by session.project", async () => {
    const session = {
      id: "ses_target",
      project: "target-project",
      cwd: "/tmp/target",
      startedAt: "2026-03-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    };
    const sessionOther = {
      id: "ses_other",
      project: "other-project",
      cwd: "/tmp/other",
      startedAt: "2026-03-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    };

    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.sessions, sessionOther.id, sessionOther);

    const obsTarget = makeObs("obs_target", "Target project observation", "ses_target");
    const obsOther = makeObs("obs_other", "Other project observation", "ses_other");

    const searchResults: HybridSearchResult[] = [
      makeHybrid(obsTarget, "ses_target"),
      makeHybrid(obsOther, "ses_other"),
    ];

    const searchFn = async (_query: string, _limit: number) => searchResults;
    registerSmartSearchFunction(sdk as never, kv as never, searchFn);

    const result = (await sdk.trigger("mem::smart-search", {
      query: "observation",
      project: "target-project",
    })) as { mode: string; results: CompactSearchResult[] };

    expect(result.mode).toBe("compact");
    const ids = result.results.map((r) => r.obsId);
    expect(ids).toContain("obs_target");
    expect(ids).not.toContain("obs_other");
  });
});
