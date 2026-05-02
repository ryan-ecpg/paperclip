import { describe, expect, it } from "vitest";
import {
  maskUserNameForLogs,
  redactCurrentUserText,
  redactCurrentUserValue,
} from "../log-redaction.js";
import { REDACTED_EVENT_VALUE, redactSensitiveText, redactSensitiveValue } from "../redaction.js";

describe("log redaction", () => {
  it("redacts the active username inside home-directory paths", () => {
    const userName = "paperclipuser";
    const maskedUserName = maskUserNameForLogs(userName);
    const input = [
      `cwd=/Users/${userName}/paperclip`,
      `home=/home/${userName}/workspace`,
      `win=C:\\Users\\${userName}\\paperclip`,
    ].join("\n");

    const result = redactCurrentUserText(input, {
      userNames: [userName],
      homeDirs: [`/Users/${userName}`, `/home/${userName}`, `C:\\Users\\${userName}`],
    });

    expect(result).toContain(`cwd=/Users/${maskedUserName}/paperclip`);
    expect(result).toContain(`home=/home/${maskedUserName}/workspace`);
    expect(result).toContain(`win=C:\\Users\\${maskedUserName}\\paperclip`);
    expect(result).not.toContain(userName);
  });

  it("redacts standalone username mentions without mangling larger tokens", () => {
    const userName = "paperclipuser";
    const maskedUserName = maskUserNameForLogs(userName);
    const result = redactCurrentUserText(
      `user ${userName} said ${userName}/project should stay but apaperclipuserz should not change`,
      {
        userNames: [userName],
        homeDirs: [],
      },
    );

    expect(result).toBe(
      `user ${maskedUserName} said ${maskedUserName}/project should stay but apaperclipuserz should not change`,
    );
  });

  it("recursively redacts nested event payloads", () => {
    const userName = "paperclipuser";
    const maskedUserName = maskUserNameForLogs(userName);
    const result = redactCurrentUserValue({
      cwd: `/Users/${userName}/paperclip`,
      prompt: `open /Users/${userName}/paperclip/ui`,
      nested: {
        author: userName,
      },
      values: [userName, `/home/${userName}/project`],
    }, {
      userNames: [userName],
      homeDirs: [`/Users/${userName}`, `/home/${userName}`],
    });

    expect(result).toEqual({
      cwd: `/Users/${maskedUserName}/paperclip`,
      prompt: `open /Users/${maskedUserName}/paperclip/ui`,
      nested: {
        author: maskedUserName,
      },
      values: [maskedUserName, `/home/${maskedUserName}/project`],
    });
  });

  it("skips redaction when disabled", () => {
    const input = "cwd=/Users/paperclipuser/paperclip";
    expect(redactCurrentUserText(input, { enabled: false })).toBe(input);
  });

  it("redacts MF-2 secret shapes before publishing live log chunks", () => {
    const fixtures = [
      {
        label: "anthropic key",
        chunk: `Anthropic key sk-ant-api03-${"a".repeat(32)}`,
        leakedTail: "a".repeat(32),
      },
      {
        label: "supabase pat",
        chunk: `Supabase PAT sbp_${"b".repeat(32)}`,
        leakedTail: "b".repeat(32),
      },
      {
        label: "supabase secret key",
        chunk: `Supabase secret sb_secret_${"c".repeat(32)}`,
        leakedTail: "c".repeat(32),
      },
      {
        label: "jwt",
        chunk: "Token header123.payload123.signature123",
        leakedTail: "signature123",
      },
      {
        label: "pem block",
        chunk: [
          "-----BEGIN PRIVATE KEY-----",
          "synthetic-private-key-material",
          "-----END PRIVATE KEY-----",
        ].join("\n"),
        leakedTail: "synthetic-private-key-material",
      },
    ];

    for (const fixture of fixtures) {
      const result = redactSensitiveText(
        redactCurrentUserText(fixture.chunk, {
          userNames: ["paperclipuser"],
          homeDirs: ["/home/paperclipuser"],
        }),
      );

      expect(result, fixture.label).toContain(REDACTED_EVENT_VALUE);
      expect(result, fixture.label).not.toContain(fixture.leakedTail);
    }
  });

  it("recursively redacts secret-shaped strings in structured values", () => {
    const tokenTail = "a".repeat(32);
    const nestedValue = {
      result: `structured result carried sbp_${tokenTail}`,
      tool_result: {
        content: [
          {
            text: `escaped payload {\\"access_token\\":\\"ghp_${"b".repeat(32)}\\"}`,
          },
        ],
      },
      metadata: {
        authorization: `Bearer ${["header12345", "payload12345", "signature12345"].join(".")}`,
      },
    };

    const redacted = redactSensitiveValue(nestedValue);
    const serialized = JSON.stringify(redacted);

    expect(serialized).toContain(REDACTED_EVENT_VALUE);
    expect(serialized).not.toContain(tokenTail);
    expect(serialized).not.toContain("b".repeat(32));
    expect(redacted.metadata.authorization).toBe(REDACTED_EVENT_VALUE);
  });

  it.each([
    {
      label: "supabase pat",
      token: `sbp_${"b".repeat(32)}`,
      leakedTail: "b".repeat(32),
    },
    {
      label: "supabase secret key",
      token: `sb_secret_${"c".repeat(32)}`,
      leakedTail: "c".repeat(32),
    },
    {
      label: "github token",
      token: `ghp_${"d".repeat(32)}`,
      leakedTail: "d".repeat(32),
    },
    {
      label: "jwt",
      token: ["header1234", "payload1234", "signature1234"].join("."),
      leakedTail: "signature1234",
    },
  ])("redacts $label after escaped JSON newlines", ({ token, leakedTail }) => {
    const result = redactSensitiveText(`assistant text before\\n${token}`);

    expect(result).toContain(REDACTED_EVENT_VALUE);
    expect(result).not.toContain(leakedTail);
  });
});
