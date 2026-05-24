import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

import { registerRememberFunction } from "../src/functions/remember.js";
import type { Memory } from "../src/types.js";

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
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload: unknown }) => {
      const fn = functions.get(input.function_id);
      // Allow mem::cascade-update to be called without implementation
      if (input.function_id === "mem::cascade-update") {
        return { success: true };
      }
      if (!fn) throw new Error(`unknown fn ${input.function_id}`);
      return fn(input.payload);
    },
  };
}

describe("mem::remember project field isolation", () => {
  it("saves memory with project field when provided", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const result = (await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "This is a test memory for project-foo",
        type: "pattern",
        project: "project-foo",
      },
    })) as { success: boolean; memory: Memory };

    expect(result.success).toBe(true);
    expect(result.memory.project).toBe("project-foo");

    const savedMemories = await kv.list<Memory>("mem:memories");
    expect(savedMemories).toHaveLength(1);
    expect(savedMemories[0].project).toBe("project-foo");
    expect(savedMemories[0].content).toBe("This is a test memory for project-foo");
  });

  it("saves memory without project field (undefined) when not provided", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const result = (await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "This is a global memory",
        type: "fact",
      },
    })) as { success: boolean; memory: Memory };

    expect(result.success).toBe(true);
    expect(result.memory.project).toBeUndefined();

    const savedMemories = await kv.list<Memory>("mem:memories");
    expect(savedMemories).toHaveLength(1);
    expect(savedMemories[0].project).toBeUndefined();
  });

  it("preserves project isolation across multiple memories", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    // Create memory for project-a
    const result1 = (await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "Memory for project A",
        project: "project-a",
      },
    })) as { success: boolean; memory: Memory };

    // Create memory for project-b
    const result2 = (await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "Memory for project B",
        project: "project-b",
      },
    })) as { success: boolean; memory: Memory };

    // Create global memory (no project)
    const result3 = (await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "Global memory",
      },
    })) as { success: boolean; memory: Memory };

    expect(result1.memory.project).toBe("project-a");
    expect(result2.memory.project).toBe("project-b");
    expect(result3.memory.project).toBeUndefined();

    const savedMemories = await kv.list<Memory>("mem:memories");
    expect(savedMemories).toHaveLength(3);

    // Verify each memory maintained its project context
    const byProject = new Map<string | undefined, Memory>();
    for (const mem of savedMemories) {
      byProject.set(mem.project, mem);
    }
    expect(byProject.get("project-a")?.content).toBe("Memory for project A");
    expect(byProject.get("project-b")?.content).toBe("Memory for project B");
    expect(byProject.get(undefined)?.content).toBe("Global memory");
  });

  it("includes project field in returned memory object", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const result = (await sdk.trigger({
      function_id: "mem::remember",
      payload: {
        content: "Memory with explicit project",
        type: "workflow",
        project: "test-project",
      },
    })) as { success: boolean; memory: Memory };

    // Check the immediate return value
    expect(result.success).toBe(true);
    expect(result.memory).toHaveProperty("project");
    expect(result.memory.project).toBe("test-project");
    expect(result.memory.id).toBeDefined();
    expect(result.memory.createdAt).toBeDefined();
    expect(result.memory.type).toBe("workflow");
  });
});
