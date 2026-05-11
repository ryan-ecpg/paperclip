import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertContained, scrubCodexRolloutFiles } from "../scrubRolloutFiles.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

async function makeCodexHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-scrub-"));
}

function dateDir(codexHome: string, date: Date) {
  return path.join(
    codexHome,
    "sessions",
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
  );
}

describe("scrubCodexRolloutFiles", () => {
  it("redacts string fields inside matching rollout JSONL files", async () => {
    const codexHome = await makeCodexHome();
    const startedAt = new Date();
    const dir = dateDir(codexHome, startedAt);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "rollout-current.jsonl");
    await fs.writeFile(file, `${JSON.stringify({ type: "item", nested: { text: JWT } })}\n`, "utf-8");

    await scrubCodexRolloutFiles({ codexHome, startedAt, endedAt: new Date(), onLog: async () => {} });

    const out = await fs.readFile(file, "utf-8");
    expect(out).toContain("***REDACTED***");
    expect(out).not.toContain(JWT);
    expect(JSON.parse(out.trim())).toEqual({ type: "item", nested: { text: "***REDACTED***" } });
  });

  it("replaces an unparseable line with a valid JSON placeholder", async () => {
    const codexHome = await makeCodexHome();
    const startedAt = new Date();
    const dir = dateDir(codexHome, startedAt);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "rollout-current.jsonl");
    await fs.writeFile(file, `not-json\n${JSON.stringify({ text: JWT })}\n`, "utf-8");

    await scrubCodexRolloutFiles({ codexHome, startedAt, endedAt: new Date(), onLog: async () => {} });

    const lines = (await fs.readFile(file, "utf-8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toEqual({
      _paperclip_scrub_error: true,
      reason: "json_parse_error",
      line_index: 0,
    });
    expect(lines[1]).toEqual({ text: "***REDACTED***" });
  });

  it("throws for paths outside the codex home sandbox", () => {
    const codexHome = path.join(os.tmpdir(), "paperclip-codex-home");

    expect(() => assertContained(`${codexHome}_other/rollout.jsonl`, codexHome)).toThrow(/Path escape/);
  });

  it("does not modify rollout files outside the mtime fence", async () => {
    const codexHome = await makeCodexHome();
    const startedAt = new Date();
    const dir = dateDir(codexHome, startedAt);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "rollout-old.jsonl");
    await fs.writeFile(file, `${JSON.stringify({ text: JWT })}\n`, "utf-8");
    const old = new Date(startedAt.getTime() - 10 * 60 * 1000);
    await fs.utimes(file, old, old);

    await scrubCodexRolloutFiles({ codexHome, startedAt, endedAt: new Date(), onLog: async () => {} });

    expect(await fs.readFile(file, "utf-8")).toContain(JWT);
  });

  it("throws on unreadable rollout candidates", async () => {
    const codexHome = await makeCodexHome();
    const startedAt = new Date();
    const dir = dateDir(codexHome, startedAt);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "rollout-current.jsonl");
    await fs.writeFile(file, `${JSON.stringify({ text: JWT })}\n`, "utf-8");
    await fs.chmod(file, 0o000);

    try {
      await expect(
        scrubCodexRolloutFiles({ codexHome, startedAt, endedAt: new Date(), onLog: async () => {} }),
      ).rejects.toThrow();
    } finally {
      await fs.chmod(file, 0o600);
    }
  });
});
