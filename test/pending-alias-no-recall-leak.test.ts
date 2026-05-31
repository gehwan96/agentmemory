/**
 * Phase 2: pending aliases must NOT expand recall scope.
 *
 * Before this fix, expandWithPending() was called during search when a project
 * appeared in any pending alias pair.  That meant memories from sibling repos
 * (e.g. nc-notification-email ↔ nc-notification-ktb) were silently surfaced
 * to each other while awaiting human review — the exact contamination issue in
 * a multi-repo environment with similarly-named services.
 *
 * After the fix, search always uses expandProjectAliases() (confirmed aliases
 * only) regardless of pending state.  Pending pairs are advisory suggestions;
 * they never widen the live recall window.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  loadPendingAliases,
  savePendingAliases,
  loadProjectAliases,
  saveProjectAliases,
  expandProjectAliases,
  isPendingProject,
  expandWithPending,
} from "../src/mcp/project-aliases.js";

// Use temp file overrides provided by the test framework
const TEMP_ALIASES = `/tmp/test-aliases-${process.pid}.json`;
const TEMP_PENDING = `/tmp/test-pending-${process.pid}.json`;

beforeEach(() => {
  process.env["AGENTMEMORY_ALIASES_FILE"] = TEMP_ALIASES;
  process.env["AGENTMEMORY_PENDING_FILE"] = TEMP_PENDING;
  // Clear both stores and the in-memory cache
  saveProjectAliases([]);
  savePendingAliases({ pending: [], rejected: [] });
});

describe("pending aliases do not expand recall scope (Phase 2 fix)", () => {
  it("search uses confirmed-only expansion even when project is in a pending pair", () => {
    // Simulate nc-notification-email ↔ nc-notification-ktb pending pair
    // (Jaccard score 0.5, triggered automatically by suggestAliasIfNew)
    savePendingAliases({
      pending: [
        {
          id: "test-1",
          projectA: "nc-notification-email",
          projectB: "nc-notification-ktb",
          score: 0.5,
          signals: ["jaccard:0.50"],
          detectedAt: new Date().toISOString(),
        },
      ],
      rejected: [],
    });

    // isPendingProject must still see the pair (for the UI / human review flow)
    expect(isPendingProject("nc-notification-email")).toBe(true);

    // expandWithPending would have returned both — kept available for tests
    // to verify the old dangerous behavior is now isolated to admin paths
    const withPending = expandWithPending("nc-notification-email");
    expect(withPending).toContain("nc-notification-ktb"); // still in expandWithPending (admin API)

    // expandProjectAliases (the path now used in search) must NOT include the sibling
    const confirmed = expandProjectAliases("nc-notification-email");
    expect(confirmed).toEqual(["nc-notification-email"]);
    expect(confirmed).not.toContain("nc-notification-ktb");
  });

  it("expandProjectAliases returns sibling once confirmed alias is saved", () => {
    // Simulate user clicking "Approve" in the alias admin UI
    saveProjectAliases([
      {
        canonical: "nc-notification-email",
        aliases: ["nc-notification-ktb"],
      },
    ]);

    const confirmed = expandProjectAliases("nc-notification-email");
    expect(confirmed).toContain("nc-notification-email");
    expect(confirmed).toContain("nc-notification-ktb");
  });

  it("no pending pair → expandProjectAliases returns project only", () => {
    const confirmed = expandProjectAliases("doridesk");
    expect(confirmed).toEqual(["doridesk"]);
  });
});
