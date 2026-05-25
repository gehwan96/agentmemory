import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let aliasesFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentmemory-alias-test-"));
  aliasesFile = join(tmpDir, "project-aliases.json");
  process.env["AGENTMEMORY_ALIASES_FILE"] = aliasesFile;
});

afterEach(async () => {
  delete process.env["AGENTMEMORY_ALIASES_FILE"];
  // Invalidate cache so next test starts fresh
  const { invalidateAliasCache } = await import("../src/mcp/project-aliases.js");
  invalidateAliasCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadProjectAliases", () => {
  it("returns empty array when file does not exist", async () => {
    const { loadProjectAliases } = await import("../src/mcp/project-aliases.js");
    expect(loadProjectAliases()).toEqual([]);
  });

  it("parses aliases file correctly", async () => {
    writeFileSync(aliasesFile, JSON.stringify({
      aliases: [
        { canonical: "/Users/me/project-a", aliases: ["E-mail", "email"] },
      ],
    }));
    const { loadProjectAliases, invalidateAliasCache } = await import("../src/mcp/project-aliases.js");
    invalidateAliasCache();
    const result = loadProjectAliases();
    expect(result).toHaveLength(1);
    expect(result[0].canonical).toBe("/Users/me/project-a");
    expect(result[0].aliases).toContain("E-mail");
  });

  it("returns empty array on malformed JSON", async () => {
    writeFileSync(aliasesFile, "not-json");
    const { loadProjectAliases, invalidateAliasCache } = await import("../src/mcp/project-aliases.js");
    invalidateAliasCache();
    expect(loadProjectAliases()).toEqual([]);
  });
});

describe("resolveCanonicalProject", () => {
  it("returns input unchanged when no alias matches", async () => {
    const { resolveCanonicalProject, invalidateAliasCache } = await import("../src/mcp/project-aliases.js");
    invalidateAliasCache();
    expect(resolveCanonicalProject("/Users/me/unknown")).toBe("/Users/me/unknown");
  });

  it("returns canonical when input is an alias", async () => {
    writeFileSync(aliasesFile, JSON.stringify({
      aliases: [{ canonical: "/Users/me/project-a", aliases: ["E-mail", "email-svc"] }],
    }));
    const { resolveCanonicalProject, invalidateAliasCache } = await import("../src/mcp/project-aliases.js");
    invalidateAliasCache();
    expect(resolveCanonicalProject("E-mail")).toBe("/Users/me/project-a");
    expect(resolveCanonicalProject("email-svc")).toBe("/Users/me/project-a");
  });

  it("returns canonical as-is when input is already canonical", async () => {
    writeFileSync(aliasesFile, JSON.stringify({
      aliases: [{ canonical: "/Users/me/project-a", aliases: ["E-mail"] }],
    }));
    const { resolveCanonicalProject, invalidateAliasCache } = await import("../src/mcp/project-aliases.js");
    invalidateAliasCache();
    expect(resolveCanonicalProject("/Users/me/project-a")).toBe("/Users/me/project-a");
  });
});

describe("expandProjectAliases", () => {
  it("returns [name] when no mapping exists", async () => {
    const { expandProjectAliases, invalidateAliasCache } = await import("../src/mcp/project-aliases.js");
    invalidateAliasCache();
    expect(expandProjectAliases("unknown")).toEqual(["unknown"]);
  });

  it("returns canonical + all aliases", async () => {
    writeFileSync(aliasesFile, JSON.stringify({
      aliases: [{ canonical: "/Users/me/project-a", aliases: ["E-mail", "email-svc"] }],
    }));
    const { expandProjectAliases, invalidateAliasCache } = await import("../src/mcp/project-aliases.js");
    invalidateAliasCache();
    const result = expandProjectAliases("/Users/me/project-a");
    expect(result).toContain("/Users/me/project-a");
    expect(result).toContain("E-mail");
    expect(result).toContain("email-svc");
    expect(result).toHaveLength(3);
  });

  it("expands correctly when given an alias name", async () => {
    writeFileSync(aliasesFile, JSON.stringify({
      aliases: [{ canonical: "/Users/me/project-a", aliases: ["E-mail"] }],
    }));
    const { expandProjectAliases, invalidateAliasCache } = await import("../src/mcp/project-aliases.js");
    invalidateAliasCache();
    const result = expandProjectAliases("E-mail");
    expect(result).toContain("/Users/me/project-a");
    expect(result).toContain("E-mail");
  });
});

describe("saveProjectAliases", () => {
  it("persists aliases and invalidates cache", async () => {
    const { saveProjectAliases, loadProjectAliases, invalidateAliasCache } = await import("../src/mcp/project-aliases.js");
    invalidateAliasCache();
    saveProjectAliases([{ canonical: "/Users/me/proj", aliases: ["short"] }]);
    invalidateAliasCache();
    const result = loadProjectAliases();
    expect(result).toHaveLength(1);
    expect(result[0].canonical).toBe("/Users/me/proj");
  });
});
