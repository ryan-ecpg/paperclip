import { describe, expect, it, vi } from "vitest";
import { walkStringFields } from "../index.js";

describe("walkStringFields", () => {
  it("applies the callback to a flat string", () => {
    const fn = vi.fn((value: string) => value.toUpperCase());

    expect(walkStringFields("hello", fn)).toBe("HELLO");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("visits nested object string leaves and leaves non-strings untouched", () => {
    const result = walkStringFields(
      {
        top: "a",
        nested: {
          keepNumber: 1,
          keepBool: false,
          leaf: "b",
        },
      },
      (value) => `${value}!`,
    );

    expect(result).toEqual({
      top: "a!",
      nested: {
        keepNumber: 1,
        keepBool: false,
        leaf: "b!",
      },
    });
  });

  it("visits strings inside arrays of objects", () => {
    const result = walkStringFields(
      [{ value: "a" }, { nested: ["b", { value: "c" }] }],
      (value) => value.repeat(2),
    );

    expect(result).toEqual([{ value: "aa" }, { nested: ["bb", { value: "cc" }] }]);
  });

  it("leaves mixed primitive values unchanged", () => {
    expect(walkStringFields(null, (value) => value)).toBeNull();
    expect(walkStringFields(1, (value) => value)).toBe(1);
    expect(walkStringFields(true, (value) => value)).toBe(true);
  });
});
