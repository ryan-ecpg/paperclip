import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { redactSensitiveText } from "../redaction.js";
import { MAX_PERSISTED_LOG_CHUNK_CHARS } from "./run-log-limits.js";

export type RunLogStoreType = "local_file";

export interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string;
}

export interface RunLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface RunLogReadResult {
  content: string;
  nextOffset?: number;
}

export interface RunLogFinalizeSummary {
  bytes: number;
  sha256?: string;
  compressed: boolean;
}

export interface RunLogStore {
  begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<number>;
  finalize(handle: RunLogHandle): Promise<RunLogFinalizeSummary>;
  read(handle: RunLogHandle, opts?: RunLogReadOptions): Promise<RunLogReadResult>;
}

function safeSegments(...segments: string[]) {
  return segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function resolveWithin(basePath: string, relativePath: string) {
  const resolved = path.resolve(basePath, relativePath);
  const base = path.resolve(basePath) + path.sep;
  if (!resolved.startsWith(base) && resolved !== path.resolve(basePath)) {
    throw new Error("Invalid log path");
  }
  return resolved;
}

const MAX_REDACTION_TAIL_CHARS = MAX_PERSISTED_LOG_CHUNK_CHARS;

function createLocalFileRunLogStore(basePath: string): RunLogStore {
  // Keep the redaction tail at least as large as the largest single persisted chunk so split anchors never hit disk.
  if (MAX_REDACTION_TAIL_CHARS < MAX_PERSISTED_LOG_CHUNK_CHARS) {
    throw new Error("Run-log redaction tail must cover the maximum persisted log chunk size");
  }

  const redactionTails = new Map<string, string>();

  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  function redactionTailKey(handle: RunLogHandle, stream: string) {
    return `${handle.logRef}:${stream}`;
  }

  async function appendRedacted(handle: RunLogHandle, event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string }) {
    if (!event.chunk) return 0;
    const absPath = resolveWithin(basePath, handle.logRef);
    const line = JSON.stringify({
      ts: event.ts,
      stream: event.stream,
      chunk: event.chunk,
    });
    const persisted = `${line}\n`;
    await fs.appendFile(absPath, persisted, "utf8");
    return Buffer.byteLength(persisted, "utf8");
  }

  function redactWithTail(handle: RunLogHandle, event: { stream: "stdout" | "stderr" | "system"; chunk: string }) {
    const key = redactionTailKey(handle, event.stream);
    const previousTail = redactionTails.get(key) ?? "";
    const redacted = redactSensitiveText(`${previousTail}${event.chunk}`);
    const splitAt = Math.max(0, redacted.length - MAX_REDACTION_TAIL_CHARS);
    const chunk = redacted.slice(0, splitAt);
    const tail = redactSensitiveText(redacted.slice(splitAt));
    if (tail) redactionTails.set(key, tail);
    else redactionTails.delete(key);
    return chunk;
  }

  async function flushRedactionTails(handle: RunLogHandle) {
    let bytes = 0;
    for (const stream of ["stdout", "stderr", "system"] as const) {
      const key = redactionTailKey(handle, stream);
      const tail = redactionTails.get(key);
      redactionTails.delete(key);
      if (!tail) continue;
      bytes += await appendRedacted(handle, {
        stream,
        ts: new Date().toISOString(),
        chunk: redactSensitiveText(tail),
      });
    }
    return bytes;
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<RunLogReadResult> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw notFound("Run log not found");

    const start = Math.max(0, Math.min(offset, stat.size));
    const end = Math.max(start, Math.min(start + limitBytes - 1, stat.size - 1));

    if (start > end) {
      return { content: "", nextOffset: start };
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { start, end });
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });

    const content = Buffer.concat(chunks).toString("utf8");
    const nextOffset = end + 1 < stat.size ? end + 1 : undefined;
    return { content, nextOffset };
  }

  async function sha256File(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      const relDir = path.join(companyId, agentId);
      const relPath = path.join(relDir, `${runId}.ndjson`);
      await ensureDir(relDir);

      const absPath = resolveWithin(basePath, relPath);
      await fs.writeFile(absPath, "", "utf8");
      for (const key of redactionTails.keys()) {
        if (key.startsWith(`${relPath}:`)) redactionTails.delete(key);
      }

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return 0;
      const chunk = redactWithTail(handle, event);
      if (!chunk) return 0;
      return appendRedacted(handle, { ...event, chunk });
    },

    async finalize(handle) {
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false };
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");
      await flushRedactionTails(handle);

      const hash = await sha256File(absPath);
      const finalStat = await fs.stat(absPath);
      return {
        bytes: finalStat.size,
        sha256: hash,
        compressed: false,
      };
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") {
        throw notFound("Run log not found");
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;
      return readFileRange(absPath, offset, limitBytes);
    },
  };
}

let cachedStore: RunLogStore | null = null;
let cachedStoreBasePath: string | null = null;

export function getRunLogStore() {
  const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  if (cachedStore && cachedStoreBasePath === basePath) return cachedStore;
  cachedStore = createLocalFileRunLogStore(basePath);
  cachedStoreBasePath = basePath;
  return cachedStore;
}
