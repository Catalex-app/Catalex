import { describe, expect, it } from "vitest";
import { usesWorkspaceVibrancy } from "./workspace-vibrancy";

describe("workspace vibrancy", () => {
  it.each([
    ["darwin", "modern", true, false, false, true],
    ["darwin", "classic", true, false, false, false],
    ["darwin", undefined, true, false, false, false],
    ["darwin", "modern", false, false, false, false],
    ["darwin", "modern", true, false, true, false],
    ["darwin", undefined, false, true, false, true],
    ["darwin", "modern", false, true, false, true],
    ["darwin", undefined, false, true, true, false],
    ["win32", "modern", true, false, false, false],
    ["linux", "modern", true, false, false, false],
    ["linux", undefined, false, true, false, false],
  ])("with platform %s, theme %s, workspace %s, welcome %s, reduced transparency %s", (platform, theme, hasWorkspace, isWelcomeScreen, reducedTransparency, enabled) => {
    expect(
      usesWorkspaceVibrancy(
        platform,
        theme,
        hasWorkspace,
        isWelcomeScreen,
        reducedTransparency,
      ),
    ).toBe(enabled);
  });
});
