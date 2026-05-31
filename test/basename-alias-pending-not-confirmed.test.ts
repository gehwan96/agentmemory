/**
 * Phase 2: basename match should create a PENDING suggestion, not a confirmed alias.
 *
 * Before this fix, findConfidentMatch() auto-confirmed an alias whenever two
 * absolute paths shared the same basename — so /team-a/api and /team-b/api
 * (or two different git worktrees of unrelated repos that happened to be named
 * identically) were silently merged without human review.
 *
 * After the fix, findConfidentMatch() only auto-confirms on:
 *   - normalize: case/separator-insensitive identity   (e.g. "E-mail" ↔ "email")
 *   - realpath: both paths resolve to the same inode   (e.g. symlink ↔ target)
 *
 * basename identity now creates a pending suggestion instead (same as Jaccard).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  findConfidentMatch,
  loadPendingAliases,
  loadProjectAliases,
  saveProjectAliases,
  savePendingAliases,
} from "../src/mcp/project-aliases.js";
import { suggestAliasIfNew } from "../src/mcp/project-alias-suggest.js";

// Minimal KV stub — suggestAliasIfNew only needs kv.list to enumerate sessions
const mockKv = {
  async list() { return []; },
  async get() { return null; },
  async set() {},
} as any;

const TEMP_ALIASES = `/tmp/test-basename-aliases-${process.pid}.json`;
const TEMP_PENDING = `/tmp/test-basename-pending-${process.pid}.json`;

beforeEach(() => {
  process.env["AGENTMEMORY_ALIASES_FILE"] = TEMP_ALIASES;
  process.env["AGENTMEMORY_PENDING_FILE"] = TEMP_PENDING;
  saveProjectAliases([]);
  savePendingAliases({ pending: [], rejected: [] });
});

describe("basename match creates pending, not confirmed (Phase 2 fix)", () => {
  it("findConfidentMatch does NOT return a match for basename-only identity", () => {
    const result = findConfidentMatch(
      "/Users/team-a/api",
      ["/Users/team-b/api"],
    );
    // basename "api" === "api" but is no longer a confident signal
    expect(result).toBeNull();
  });

  it("findConfidentMatch still returns a match for normalize identity", () => {
    const result = findConfidentMatch("E-mail", ["email"]);
    expect(result).not.toBeNull();
    expect(result!.signal).toBe("normalize");
  });

  it("suggestAliasIfNew adds basename pair to PENDING, not confirmed", async () => {
    // Seed a known project with an absolute path
    saveProjectAliases([]);
    savePendingAliases({ pending: [], rejected: [] });
    // Manually add a "known" project by pre-populating the pending store with
    // one session so collectKnownProjects has something to compare against.
    // We do this by directly writing a confirmed alias (non-matching) to fill
    // the "existing" list, then call suggestAliasIfNew for a basename-only match.

    // Simulate: user has been working in /Users/nhn/project/api (team-a)
    // A new session starts in /Users/nhn/project-b/api (different repo, same basename)
    // We test via a KV that returns one session with the known path
    const mockKvWithSession = {
      async list() {
        return [{ project: "/Users/nhn/project/api", id: "s1", cwd: "/Users/nhn/project/api", startedAt: "", status: "completed", observationCount: 0 }];
      },
      async get() { return null; },
      async set() {},
    } as any;

    await suggestAliasIfNew("/Users/nhn/project-b/api", mockKvWithSession);

    const aliases = loadProjectAliases();
    const pending = loadPendingAliases();

    // Must NOT be in confirmed aliases
    const confirmedNames = aliases.flatMap(a => [a.canonical, ...a.aliases]);
    expect(confirmedNames).not.toContain("/Users/nhn/project-b/api");

    // MUST be in pending (basename signal)
    const pendingPair = pending.pending.find(
      p =>
        (p.projectA === "/Users/nhn/project-b/api" || p.projectB === "/Users/nhn/project-b/api") &&
        p.signals.some(s => s === "basename"),
    );
    expect(pendingPair).toBeDefined();
  });

  it("normalize-identical paths are still auto-confirmed (realpath/normalize remain confident)", () => {
    const result = findConfidentMatch("nc-notification-Email", ["nc-notification-email"]);
    // normalize removes separators + lowercases → both become "ncnotificationemail"
    expect(result).not.toBeNull();
    expect(result!.signal).toBe("normalize");
  });
});
