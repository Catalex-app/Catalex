export function usesWorkspaceVibrancy(
  platform: string,
  theme: string | undefined,
  hasWorkspace: boolean,
  isWelcomeScreen: boolean,
  reducedTransparency: boolean,
): boolean {
  return (
    platform === "darwin" &&
    (isWelcomeScreen || (hasWorkspace && theme === "modern")) &&
    !reducedTransparency
  );
}
