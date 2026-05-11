import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactSensitiveText, walkStringFields } from "@paperclipai/redaction";

type LogFn = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

export function assertContained(filePath: string, sandboxRoot: string): void {
  const resolvedFile = path.resolve(filePath);
  const resolvedRoot = path.resolve(sandboxRoot);
  const rel = path.relative(resolvedRoot, resolvedFile);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escape: ${resolvedFile} is outside ${resolvedRoot}`);
  }
}

export function encodeClaudeProjectPath(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

export function resolveClaudeSessionJsonlPath(input: {
  sessionId: string;
  cwd: string;
  env: Record<string, string>;
}): string {
  const configDir = input.env.CLAUDE_CONFIG_DIR?.trim() ||
    path.join(input.env.HOME?.trim() || os.homedir(), ".claude");
  return path.join(
    configDir,
    "projects",
    encodeClaudeProjectPath(input.cwd),
    `${input.sessionId}.jsonl`,
  );
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, contents, "utf-8");
  await fs.rename(tmpPath, filePath);
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
        `[paperclip] Warning: replaced unparseable Claude session JSONL line ${index} in ${filePath} during post-execute scrub.\n`,
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

async function scrubJsonlFile(filePath: string, sandboxRoot: string, onLog: LogFn): Promise<void> {
  assertContained(filePath, sandboxRoot);
  const original = await fs.readFile(filePath, "utf-8");
  const rewritten = await rewriteJsonl(original, filePath, onLog);
  if (rewritten !== original) {
    await atomicWrite(filePath, rewritten);
  }
}

async function scrubTextFile(filePath: string, sandboxRoot: string): Promise<void> {
  assertContained(filePath, sandboxRoot);
  const original = await fs.readFile(filePath, "utf-8");
  const rewritten = redactSensitiveText(original);
  if (rewritten !== original) {
    await atomicWrite(filePath, rewritten);
  }
}

export async function scrubClaudeSessionFiles(input: {
  sessionId: string | null;
  cwd: string;
  env: Record<string, string>;
  onLog: LogFn;
}): Promise<void> {
  if (!input.sessionId) return;
  const sessionJsonlPath = resolveClaudeSessionJsonlPath({
    sessionId: input.sessionId,
    cwd: input.cwd,
    env: input.env,
  });
  const sessionDir = path.dirname(sessionJsonlPath);
  const toolResultsDir = path.join(sessionDir, input.sessionId, "tool-results");
  try {
    await scrubJsonlFile(sessionJsonlPath, sessionDir, input.onLog);
    const entries = await fs.readdir(toolResultsDir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [];
      throw err;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".txt")) continue;
      await scrubTextFile(path.join(toolResultsDir, entry.name), toolResultsDir);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await input.onLog("stderr", `[paperclip] Claude session post-execute scrub failed: ${reason}\n`);
    throw err;
  }
}
