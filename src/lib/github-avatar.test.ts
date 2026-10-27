import { describe, expect, it } from "vitest";
import { githubAvatarUrl } from "./github-avatar";

describe("githubAvatarUrl", () => {
  it("asks GitHub for the account avatar at 2× the chip size, capped", () => {
    expect(githubAvatarUrl("libo-zhou", 20)).toBe("https://github.com/libo-zhou.png?size=40");
    expect(githubAvatarUrl("libo-zhou", 400)).toBe("https://github.com/libo-zhou.png?size=460");
  });
});
