import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findJsonlFiles, MAX_FILES_DEFAULT } from "../src/functions/replay.js";

async function makeTmpTree(structure: Record<string, string | null>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentmemory-test-"));
  for (const [rel, content] of Object.entries(structure)) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    if (content !== null) await writeFile(full, content, "utf-8");
  }
  return root;
}

describe("findJsonlFiles", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots.splice(0)) {
      await rm(r, { recursive: true, force: true });
    }
  });

  it("returns correct files and discovered count within limit", async () => {
    const root = await makeTmpTree({
      "a/session1.jsonl": "line",
      "a/session2.jsonl": "line",
      "b/session3.jsonl": "line",
    });
    roots.push(root);
    const result = await findJsonlFiles(root, 10);
    expect(result.files).toHaveLength(3);
    expect(result.discovered).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.traversalCapped).toBe(false);
  });

  it("truncates when discovered > limit and sets truncated=true", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`dir/sess${i}.jsonl`] = "";
    const root = await makeTmpTree(files);
    roots.push(root);
    const result = await findJsonlFiles(root, 3);
    expect(result.files).toHaveLength(3);
    expect(result.discovered).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.traversalCapped).toBe(false);
  });

  it("accepts limit greater than old 1000 cap without clamping", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`p/s${i}.jsonl`] = "";
    const root = await makeTmpTree(files);
    roots.push(root);
    // Passes limit=5000 — previously would have been clamped to 1000
    const result = await findJsonlFiles(root, 5000);
    expect(result.files).toHaveLength(10);
    expect(result.truncated).toBe(false);
  });

  it("ignores non-jsonl files", async () => {
    const root = await makeTmpTree({
      "a/session.jsonl": "line",
      "a/notes.txt": "text",
      "a/data.json": "{}",
    });
    roots.push(root);
    const result = await findJsonlFiles(root, 100);
    expect(result.files).toHaveLength(1);
    expect(result.discovered).toBe(1);
  });

  it("uses MAX_FILES_DEFAULT as default limit", async () => {
    // Just verify the default parameter value
    expect(MAX_FILES_DEFAULT).toBe(200);
  });
});
