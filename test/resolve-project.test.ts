import { describe, it, expect } from "vitest";
import { resolveProject } from "../src/mcp/resolve-project.js";
import type { Session } from "../src/types.js";
import { KV } from "../src/state/schema.js";

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

describe("resolveProject", () => {
  it("returns 'default' when sessionId is undefined", async () => {
    const kv = mockKV() as any;
    const result = await resolveProject(undefined, kv);
    expect(result).toBe("default");
  });

  it("returns Session.project when sessionId exists and Session is found", async () => {
    const kv = mockKV() as any;
    const session: Session = {
      id: "sess_1",
      project: "Alimtalk",
      cwd: "/home/user/project",
      startedAt: new Date().toISOString(),
      status: "active",
      observationCount: 0,
    };
    await kv.set(KV.sessions, "sess_1", session);

    const result = await resolveProject("sess_1", kv);
    expect(result).toBe("Alimtalk");
  });

  it("returns 'default' when sessionId exists but Session is not found", async () => {
    const kv = mockKV() as any;
    const result = await resolveProject("nonexistent_sess", kv);
    expect(result).toBe("default");
  });
});
