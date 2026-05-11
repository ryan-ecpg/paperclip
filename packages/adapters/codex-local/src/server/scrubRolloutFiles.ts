import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText, walkStringFields } from "@paperclipai/redaction";

type LogFn = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

const ROLLOUT_MTIME_TOLERANCE_MS = 2 * 60 * 1000;

export function assertContained(filePath: string, sandboxRoot: string): void {
  const resolvedFile = path.resolve(filePath);
  const resolvedRoot = path.resolve(sandboxRoot);
  const rel = path.relative(resolvedRoot, resolvedFile);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escape: ${resolvedFile} is outside ${resolvedRoot}`);
  }
}

function dateKey(date: Date): string {
  return [
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
  ].join("/");
}

function rolloutDateDirs(codexHome: string, startedAt: Date, endedAt: Date): string[] {
  const keys = new Set<string>();
  const cursor = new Date(Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), startedAt.getUTCDate()));
  const last = new Date(Date.UTC(endedAt.getUTCFullYear(), endedAt.getUTCMonth(), endedAt.getUTCDate()));
  while (cursor <= last) {
    keys.add(dateKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return Array.from(keys, (key) => path.join(codexHome, "sessions", ...key.split("/")));
}

async function rewriteJsonl(text: string, filePath: string, onLog: LogFn): Promise<string> {
  const hasFinalNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (hasFinalNewline) lines.pop();
  const rewritten: string[] = [];
  for (const [index, line] of lines.entries()) {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    try {
      const parsed = JSON.parse(normalized);
      rewritten.push(`${JSON.stringify(walkStringFields(parsed, redactSensitiveText))}\n`);
    } catch {
      await onLog(
        "stderr",
        `[paperclip] Warning: replaced unparseable Codex rollout JSONL line ${index} in ${filePath} during post-execute scrub.\n`,
      );
      rewritten.push(`${JSON.stringify({
        _paperclip_scrub_error: true,
        reason: "json_parse_error",
        line_index: index,
      })}\n`);
    }
  }
  return rewritten.join("");
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, contents, "utf-8");
  await fs.rename(tmpPath, filePath);
}

async function scrubJsonlFile(filePath: string, sandboxRoot: string, onLog: LogFn): Promise<void> {
  assertContained(filePath, sandboxRoot);
  const original = await fs.readFile(filePath, "utf-8");
  const rewritten = await rewriteJsonl(original, filePath, onLog);
  if (rewritten !== original) {
    await atomicWrite(filePath, rewritten);
  }
}

export async function scrubCodexRolloutFiles(input: {
  codexHome: string;
  startedAt: Date;
  endedAt: Date;
  onLog: LogFn;
}): Promise<void> {
  const lowerBound = input.startedAt.getTime() - ROLLOUT_MTIME_TOLERANCE_MS;
  const upperBound = input.endedAt.getTime() + ROLLOUT_MTIME_TOLERANCE_MS;
  try {
    // Codex exposes the active thread id, but not the rollout file path. Use the
    // approved fallback: date-dir candidates filtered by the run's mtime window.
    for (const dir of rolloutDateDirs(input.codexHome, input.startedAt, input.endedAt)) {
      assertContained(dir, input.codexHome);
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return [];
        throw err;
      });
      for (const entry of entries) {
        if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) continue;
        const filePath = path.join(dir, entry.name);
        assertContained(filePath, input.codexHome);
        const stat = await fs.stat(filePath);
        const mtime = stat.mtimeMs;
        if (mtime < lowerBound || mtime > upperBound) continue;
        await scrubJsonlFile(filePath, input.codexHome, input.onLog);
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await input.onLog("stderr", `[paperclip] Codex rollout post-execute scrub failed: ${reason}\n`);
    throw err;
  }
}
