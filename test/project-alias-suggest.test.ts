import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let aliasesFile: string;
let pendingFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentmemory-suggest-test-"));
  aliasesFile = join(tmpDir, "project-aliases.json");
  pendingFile = join(tmpDir, "project-aliases-pending.json");
  process.env["AGENTMEMORY_ALIASES_FILE"] = aliasesFile;
  process.env["AGENTMEMORY_PENDING_FILE"] = pendingFile;
});

afterEach(async () => {
  delete process.env["AGENTMEMORY_ALIASES_FILE"];
  delete process.env["AGENTMEMORY_PENDING_FILE"];
  const { invalidateAliasCache, invalidatePendingCache } = await import(
    "../src/mcp/project-aliases.js"
  );
  invalidateAliasCache();
  invalidatePendingCache();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Minimal stub kv that returns sessions with known project values.
function makeKv(projects: string[]) {
  return {
    list: vi.fn().mockImplementation((ns: string) => {
      if (ns === "mem:sessions") {
        return Promise.resolve(projects.map((p, i) => ({ id: `s${i}`, project: p })));
      }
      return Promise.resolve([]);
    }),
    get: vi.fn().mockResolvedValue(null),
  };
}

describe("normalizeForCompare", () => {
  it("strips separators and lowercases", async () => {
    const { normalizeForCompare } = await import("../src/mcp/project-aliases.js");
    expect(normalizeForCompare("E-mail")).toBe("email");
    expect(normalizeForCompare("Email")).toBe("email");
    expect(normalizeForCompare("EMAIL")).toBe("email");
    expect(normalizeForCompare("e_mail")).toBe("email");
    expect(normalizeForCompare("e.mail")).toBe("email");
    expect(normalizeForCompare("e mail")).toBe("email");
  });
});

describe("tokenJaccard", () => {
  it("returns 1.0 for identical strings", async () => {
    const { tokenJaccard } = await import("../src/mcp/project-aliases.js");
    expect(tokenJaccard("email", "email")).toBe(1);
  });

  it("returns 0.0 for completely unrelated strings", async () => {
    const { tokenJaccard } = await import("../src/mcp/project-aliases.js");
    expect(tokenJaccard("doridesk", "nc-notification-email")).toBe(0);
  });

  it("returns fractional score for partial overlap", async () => {
    const { tokenJaccard } = await import("../src/mcp/project-aliases.js");
    // tokens: {nc, notification, email} vs {email} → intersection=1, union=3
    const score = tokenJaccard("nc-notification-email", "email");
    expect(score).toBeCloseTo(1 / 3);
  });
});

describe("findConfidentMatch — normalize", () => {
  it("returns normalize signal when normalized forms are identical", async () => {
    const { findConfidentMatch } = await import("../src/mcp/project-aliases.js");
    const result = findConfidentMatch("Email", ["email", "/Users/x/doridesk"]);
    expect(result).not.toBeNull();
    expect(result!.signal).toBe("normalize");
    expect(result!.matched).toBe("email");
  });

  it("returns null when no match", async () => {
    const { findConfidentMatch } = await import("../src/mcp/project-aliases.js");
    expect(findConfidentMatch("doridesk", ["nc-notification-email"])).toBeNull();
  });
});

describe("suggestAliasIfNew", () => {
  it("auto-registers confident match (normalize)", async () => {
    const { loadProjectAliases } = await import("../src/mcp/project-aliases.js");
    // seed confirmed alias table so "email" is a known canonical
    writeFileSync(
      aliasesFile,
      JSON.stringify({ aliases: [{ canonical: "email", aliases: [] }] }),
    );
    const { invalidateAliasCache } = await import("../src/mcp/project-aliases.js");
    invalidateAliasCache();

    const { suggestAliasIfNew } = await import(
      "../src/mcp/project-alias-suggest.js"
    );
    const kv = makeKv(["email"]);
    await suggestAliasIfNew("Email", kv as never);

    const aliases = loadProjectAliases();
    const entry = aliases.find((a) => a.canonical === "email");
    expect(entry?.aliases).toContain("Email");
  });

  it("adds to pending when only jaccard matches", async () => {
    const { loadPendingAliases } = await import("../src/mcp/project-aliases.js");
    writeFileSync(aliasesFile, JSON.stringify({ aliases: [{ canonical: "email", aliases: [] }] }));
    const { invalidateAliasCache } = await import("../src/mcp/project-aliases.js");
    invalidateAliasCache();

    const { suggestAliasIfNew } = await import(
      "../src/mcp/project-alias-suggest.js"
    );
    const kv = makeKv(["email"]);
    // "nc-notification-email" shares token "email" with "email" → jaccard ~0.33
    await suggestAliasIfNew("nc-notification-email", kv as never);

    const store = loadPendingAliases();
    expect(store.pending.length).toBeGreaterThan(0);
    const pair = store.pending.find(
      (p) =>
        (p.projectA === "nc-notification-email" && p.projectB === "email") ||
        (p.projectA === "email" && p.projectB === "nc-notification-email"),
    );
    expect(pair).toBeDefined();
    expect(pair!.score).toBeGreaterThanOrEqual(0.3);
  });

  it("does nothing when project is already in pending", async () => {
    const { loadPendingAliases, savePendingAliases, invalidatePendingCache } =
      await import("../src/mcp/project-aliases.js");
    savePendingAliases({
      pending: [
        {
          id: "x",
          projectA: "nc-notification-email",
          projectB: "email",
          score: 0.33,
          signals: ["jaccard:0.33"],
          detectedAt: new Date().toISOString(),
        },
      ],
      rejected: [],
    });
    invalidatePendingCache();

    const { suggestAliasIfNew } = await import(
      "../src/mcp/project-alias-suggest.js"
    );
    const kv = makeKv(["email"]);
    await suggestAliasIfNew("nc-notification-email", kv as never);

    // Still only one entry
    expect(loadPendingAliases().pending).toHaveLength(1);
  });

  it("does not re-suggest rejected pairs", async () => {
    const { savePendingAliases, invalidatePendingCache, loadPendingAliases } =
      await import("../src/mcp/project-aliases.js");
    savePendingAliases({
      pending: [],
      rejected: [
        {
          projectA: "nc-notification-email",
          projectB: "email",
          rejectedAt: new Date().toISOString(),
        },
      ],
    });
    invalidatePendingCache();

    const { suggestAliasIfNew } = await import(
      "../src/mcp/project-alias-suggest.js"
    );
    const kv = makeKv(["email"]);
    await suggestAliasIfNew("nc-notification-email", kv as never);

    expect(loadPendingAliases().pending).toHaveLength(0);
  });
});

describe("isPendingProject / expandWithPending", () => {
  it("isPendingProject returns true when in pending", async () => {
    const {
      savePendingAliases,
      invalidatePendingCache,
      isPendingProject,
    } = await import("../src/mcp/project-aliases.js");
    savePendingAliases({
      pending: [
        {
          id: "x",
          projectA: "nc-notification-email",
          projectB: "email",
          score: 0.33,
          signals: [],
          detectedAt: new Date().toISOString(),
        },
      ],
      rejected: [],
    });
    invalidatePendingCache();
    expect(isPendingProject("nc-notification-email")).toBe(true);
    expect(isPendingProject("doridesk")).toBe(false);
  });

  it("expandWithPending includes pair partner", async () => {
    const {
      savePendingAliases,
      invalidatePendingCache,
      expandWithPending,
    } = await import("../src/mcp/project-aliases.js");
    savePendingAliases({
      pending: [
        {
          id: "x",
          projectA: "nc-notification-email",
          projectB: "email",
          score: 0.33,
          signals: [],
          detectedAt: new Date().toISOString(),
        },
      ],
      rejected: [],
    });
    invalidatePendingCache();
    const expanded = expandWithPending("nc-notification-email");
    expect(expanded).toContain("nc-notification-email");
    expect(expanded).toContain("email");
  });
});
