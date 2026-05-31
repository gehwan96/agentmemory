import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from "node:fs";
import { join, basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export interface ProjectAlias {
  canonical: string;
  aliases: string[];
}

// Allow tests to override the file path via environment variable.
function getAliasesFile(): string {
  return (
    process.env["AGENTMEMORY_ALIASES_FILE"] ||
    join(homedir(), ".agentmemory", "project-aliases.json")
  );
}

let _cache: ProjectAlias[] | null = null;

export function loadProjectAliases(): ProjectAlias[] {
  if (_cache !== null) return _cache;
  const file = getAliasesFile();
  if (!existsSync(file)) {
    _cache = [];
    return _cache;
  }
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as { aliases?: unknown };
    if (Array.isArray(parsed?.aliases)) {
      _cache = parsed.aliases.filter(
        (a): a is ProjectAlias =>
          typeof a?.canonical === "string" && Array.isArray(a?.aliases),
      );
    } else {
      _cache = [];
    }
  } catch {
    _cache = [];
  }
  return _cache;
}

export function invalidateAliasCache(): void {
  _cache = null;
}

// Returns the canonical name for any project name (alias or canonical).
// Falls back to the input value when no mapping is found.
// Empty or whitespace-only names are normalized to "default".
export function resolveCanonicalProject(name: string): string {
  if (!name.trim()) return "default";
  const aliases = loadProjectAliases();
  for (const entry of aliases) {
    if (entry.canonical === name) return name;
    if (entry.aliases.includes(name)) return entry.canonical;
  }
  return name;
}

// Returns all names that should be accepted when filtering by the given project:
// [canonical, ...aliases]. When no mapping exists, returns [name].
export function expandProjectAliases(name: string): string[] {
  const canonical = resolveCanonicalProject(name);
  const aliases = loadProjectAliases();
  for (const entry of aliases) {
    if (entry.canonical === canonical) {
      return [canonical, ...entry.aliases];
    }
  }
  return [canonical];
}

export function saveProjectAliases(aliases: ProjectAlias[]): void {
  const file = getAliasesFile();
  const tmp = file + "." + randomBytes(4).toString("hex") + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify({ aliases }, null, 2), "utf-8");
    renameSync(tmp, file);
    invalidateAliasCache();
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending alias layer
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingAlias {
  id: string;
  projectA: string;
  projectB: string;
  score: number;
  signals: string[];
  detectedAt: string;
}

export interface RejectedAlias {
  projectA: string;
  projectB: string;
  rejectedAt: string;
}

export interface PendingAliasStore {
  pending: PendingAlias[];
  rejected: RejectedAlias[];
}

function getPendingFile(): string {
  return (
    process.env["AGENTMEMORY_PENDING_FILE"] ||
    join(homedir(), ".agentmemory", "project-aliases-pending.json")
  );
}

let _pendingCache: PendingAliasStore | null = null;

export function loadPendingAliases(): PendingAliasStore {
  if (_pendingCache !== null) return _pendingCache;
  const file = getPendingFile();
  if (!existsSync(file)) {
    _pendingCache = { pending: [], rejected: [] };
    return _pendingCache;
  }
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PendingAliasStore>;
    _pendingCache = {
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      rejected: Array.isArray(parsed.rejected) ? parsed.rejected : [],
    };
  } catch {
    _pendingCache = { pending: [], rejected: [] };
  }
  return _pendingCache;
}

export function invalidatePendingCache(): void {
  _pendingCache = null;
}

export function savePendingAliases(store: PendingAliasStore): void {
  const file = getPendingFile();
  const tmp = file + "." + randomBytes(4).toString("hex") + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
    renameSync(tmp, file);
    invalidatePendingCache();
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Confident-match helpers
// ─────────────────────────────────────────────────────────────────────────────

// Strips case and separators for exact-match comparison: "E-mail" → "email"
export function normalizeForCompare(name: string): string {
  return name.toLowerCase().replace(/[\s\-_./]+/g, "");
}

export function isAbsolutePath(name: string): boolean {
  return isAbsolute(name);
}

// Returns [signal, matchedCanonical] if a confident match is found, otherwise null.
export function findConfidentMatch(
  newProject: string,
  existing: string[],
): { signal: string; matched: string } | null {
  const normNew = normalizeForCompare(newProject);

  for (const ex of existing) {
    if (ex === newProject) continue; // same string, already known

    // 1. Normalization identical
    if (normNew === normalizeForCompare(ex)) {
      return { signal: "normalize", matched: ex };
    }

    // 2. Both absolute paths: realpath identical (basename alone is NOT sufficient —
    //    two different repos that happen to share a name, e.g. "api", would be
    //    silently merged; basename is demoted to a pending suggestion instead,
    //    see suggestAliasIfNew in project-alias-suggest.ts)
    if (isAbsolutePath(newProject) && isAbsolutePath(ex)) {
      try {
        if (realpathSync(newProject) === realpathSync(ex)) {
          return { signal: "realpath", matched: ex };
        }
      } catch {
        // path doesn't exist or can't be resolved — skip
      }
    }
  }
  return null;
}

// Tokenizes "nc-notification-email" → ["nc", "notification", "email"]
function tokenize(name: string): Set<string> {
  return new Set(
    name
      .split(/[-_/.\s]+/)
      .map((t) => t.toLowerCase())
      .filter((t) => t.length > 0),
  );
}

export function tokenJaccard(a: string, b: string): number {
  const sa = tokenize(a);
  const sb = tokenize(b);
  let intersection = 0;
  for (const t of sa) {
    if (sb.has(t)) intersection++;
  }
  const union = new Set([...sa, ...sb]).size;
  if (union === 0) return 0;
  return intersection / union;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending-aware search expansion
// ─────────────────────────────────────────────────────────────────────────────

// Returns true if this project name appears in any pending pair.
export function isPendingProject(name: string): boolean {
  const canonical = resolveCanonicalProject(name);
  const { pending } = loadPendingAliases();
  return pending.some((p) => p.projectA === canonical || p.projectB === canonical);
}

// Like expandProjectAliases but also includes pending-pair partners.
// Used during search when the project is still under review.
export function expandWithPending(name: string): string[] {
  const base = expandProjectAliases(name);
  const canonical = resolveCanonicalProject(name);
  const { pending } = loadPendingAliases();
  const extra = new Set<string>(base);
  for (const p of pending) {
    if (p.projectA === canonical) extra.add(p.projectB);
    if (p.projectB === canonical) extra.add(p.projectA);
  }
  return [...extra];
}
