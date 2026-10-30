import {
  ReviewFileNavigation,
  type ReviewFileNavigationProps,
} from "./review-file-navigation";

export const AGENT_REVIEW_NAVIGATION_COLORS = {
  light: "var(--color-emerald-700)",
  dark: "#36ad5e",
  hoverForeground: "white",
};

export function AgentReviewFileNavigation(props: ReviewFileNavigationProps) {
  return (
    <ReviewFileNavigation
      {...props}
      labels={{
        title: "Review",
        group: "Review files",
        pending: "files awaiting review",
        previous: "Previous review file",
        previousHint: "Previous file awaiting review",
        next: "Next review file",
        nextHint: "Next file awaiting review",
      }}
      colors={AGENT_REVIEW_NAVIGATION_COLORS}
    />
  );
}
