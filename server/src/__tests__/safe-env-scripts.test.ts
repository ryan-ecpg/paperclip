import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const safeEnvDump = "/home/ryan/ecpg/scripts/safe-env-dump";
const safeEnvList = "/home/ryan/ecpg/scripts/safe-env-list";

function runScript(script: string, args: string[], env: Record<string, string>): string {
  return execFileSync("/usr/bin/bash", [script, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ...env,
    },
  });
}

describe("safe env scripts", () => {
  it("classifies mixed-case Paperclip and BWS token shapes without printing values", () => {
    const output = runScript(
      safeEnvDump,
      ["--filter", "^(mixed_pcp|underscored_bare_pcp|mixed_bws|bws_machine_bare|bws_machine_suffixed)$"],
      {
        mixed_pcp: `pCp_futurekind_${"a".repeat(20)}`,
        underscored_bare_pcp: `pcp_${"a".repeat(10)}_${"b".repeat(10)}`,
        mixed_bws: `bWs_${"b".repeat(20)}`,
        bws_machine_bare: `0.11111111-2222-3333-4444-555555555555.${"A".repeat(40)}`,
        bws_machine_suffixed: `0.11111111-2222-3333-4444-555555555555.${"A".repeat(40)}:${"B".repeat(24)}`,
      },
    );

    expect(output).toContain("mixed_pcp\tpaperclip-token\tbytes=");
    expect(output).toContain("underscored_bare_pcp\tpaperclip-token\tbytes=");
    expect(output).toContain("mixed_bws\tbws-token\tbytes=");
    expect(output).toContain("bws_machine_bare\tbws-machine-token\tbytes=");
    expect(output).toContain("bws_machine_suffixed\tbws-machine-token\tbytes=");
    expect(output).not.toContain("text");
    expect(output).not.toContain("aaaaaaaaaaaaaaaaaaaa");
    expect(output).not.toContain("bbbbbbbbbbbbbbbbbbbb");
  });

  it("filters names case-insensitively in list and dump modes", () => {
    const env = {
      MixedCase: "plain",
    };

    expect(runScript(safeEnvList, ["--filter", "^mixedcase$"], env)).toBe("MixedCase\n");
    expect(runScript(safeEnvDump, ["--filter", "^mixedcase$"], env)).toContain("MixedCase\ttext\tbytes=");
  });
});
