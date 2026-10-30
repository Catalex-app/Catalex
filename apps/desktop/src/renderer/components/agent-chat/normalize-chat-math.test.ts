import { describe, expect, it } from "vitest";
import { normalizeChatMath } from "./normalize-chat-math";

describe("chat math delimiters", () => {
  it("converts inline and display TeX math while retaining dollar math", () => {
    expect(
      normalizeChatMath(String.raw`Vectors \(u_1,\ldots,u_4\) and $v_k$.`),
    ).toBe(String.raw`Vectors $u_1,\ldots,u_4$ and $v_k$.`);
    expect(normalizeChatMath(String.raw`\[U\Sigma V^T\]`)).toBe(
      "\n\n$$\nU\\Sigma V^T\n$$\n\n",
    );
  });
  it("keeps code examples, plain parentheses, and escaped delimiters literal", () => {
    for (const source of [
      String.raw`(ordinary prose) and \\(literal\\)`,
      String.raw`Use \(unfinished`,
      "`\\(x\\)`",
      "``\\(x\\) ` code``",
      "```tex\n\\[x\\]\n```",
      "~~~tex\n\\(x\\)\n~~~",
      "```tex\n\\(unfinished\\)",
      "    \\(x\\)\n",
    ])
      expect(normalizeChatMath(source)).toBe(source);
  });
});
