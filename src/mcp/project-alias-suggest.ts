import type { StateKV } from "../state/kv.js";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import { basename } from "node:path";
import {
  loadProjectAliases,
  loadPendingAliases,
  saveProjectAliases,
  savePendingAliases,
  resolveCanonicalProject,
  findConfidentMatch,
  isAbsolutePath,
  tokenJaccard,
} from "./project-aliases.js";
import { randomUUID } from "node:crypto";

const JACCARD_THRESHOLD = 0.3;

// Returns all distinct project values currently stored in sessions.
async function collectKnownProjects(kv: StateKV): Promise<string[]> {
  const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
  const seen = new Set<string>();
  for (const s of sessions) {
    if (s.project) seen.add(s.project);
  }
  // Also include canonical values from the confirmed alias table.
  for (const entry of loadProjectAliases()) {
    seen.add(entry.canonical);
    for (const a of entry.aliases) seen.add(a);
  }
  return [...seen];
}

function isAlreadyKnown(name: string): boolean {
  const { pending, rejected } = loadPendingAliases();
  const canonical = resolveCanonicalProject(name);
  if (canonical !== name) return true; // already an alias of something
  return (
    pending.some((p) => p.projectA === canonical || p.projectB === canonical) ||
    rejected.some(
      (r) =>
        (r.projectA === canonical || r.projectB === canonical) ||
        (r.projectA === name || r.projectB === name),
    )
  );
}

function isRejectedPair(a: string, b: string): boolean {
  const { rejected } = loadPendingAliases();
  return rejected.some(
    (r) =>
      (r.projectA === a && r.projectB === b) ||
      (r.projectA === b && r.projectB === a),
  );
}

function isPendingPair(a: string, b: string): boolean {
  const { pending } = loadPendingAliases();
  return pending.some(
    (p) =>
      (p.projectA === a && p.projectB === b) ||
      (p.projectA === b && p.projectB === a),
  );
}

// Called when a new project value is encountered. Fire-and-forget — never throws.
export async function suggestAliasIfNew(
  newProject: string,
  kv: StateKV,
): Promise<void> {
  try {
    if (isAlreadyKnown(newProject)) return;

    const known = await collectKnownProjects(kv);
    // Remove the new project itself from comparison candidates.
    const candidates = known.filter((k) => k !== newProject);

    // 1. Check for confident match first.
    const confident = findConfidentMatch(newProject, candidates);
    if (confident) {
      const { matched, signal } = confident;
      const canonical = resolveCanonicalProject(matched);
      const aliases = loadProjectAliases();
      const entry = aliases.find((a) => a.canonical === canonical);
      if (entry) {
        if (!entry.aliases.includes(newProject)) {
          entry.aliases.push(newProject);
          saveProjectAliases(aliases);
        }
      } else {
        aliases.push({ canonical, aliases: [newProject] });
        saveProjectAliases(aliases);
      }
      void signal; // signal logged via object — suppress unused warning
      return;
    }

    // 2. Pending suggestions: basename match + Jaccard similarity.
    //
    // basename is a "weak" signal — two absolute paths sharing only their last
    // segment might be completely different repos (e.g. /team-a/api vs
    // /team-b/api).  We therefore add it as a pending suggestion that requires
    // human approval rather than auto-confirming it as a confident alias.
    const store = loadPendingAliases();
    let changed = false;
    for (const candidate of candidates) {
      if (isRejectedPair(newProject, candidate)) continue;
      if (isPendingPair(newProject, candidate)) continue;

      const signals: string[] = [];

      // basename signal: both are absolute paths with the same last segment
      if (
        isAbsolutePath(newProject) &&
        isAbsolutePath(candidate) &&
        basename(newProject) === basename(candidate)
      ) {
        signals.push("basename");
      }

      const score = tokenJaccard(newProject, candidate);
      if (score >= JACCARD_THRESHOLD) {
        signals.push(`jaccard:${score.toFixed(2)}`);
      }

      if (signals.length > 0) {
        store.pending.push({
          id: randomUUID(),
          projectA: newProject,
          projectB: candidate,
          score,
          signals,
          detectedAt: new Date().toISOString(),
        });
        changed = true;
      }
    }
    if (changed) {
      savePendingAliases(store);
    }
  } catch {
    // Suggestion is best-effort; never block the caller.
  }
}
