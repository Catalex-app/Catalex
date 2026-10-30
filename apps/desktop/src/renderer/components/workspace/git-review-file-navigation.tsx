import {
  ReviewFileNavigation,
  type ReviewFileNavigationProps,
} from "./review-file-navigation";

export const GIT_REVIEW_NAVIGATION_COLORS = {
  light: "var(--color-violet-700)",
  dark: "var(--color-violet-300)",
  hoverForeground: "white",
};

export function GitReviewFileNavigation(props: ReviewFileNavigationProps) {
  return (
    <ReviewFileNavigation
      {...props}
      labels={{
        title: "Resolve",
        group: "Git conflict files",
        pending: "unresolved Git files",
        previous: "Previous conflicted file",
        previousHint: "Previous conflicted file",
        next: "Next conflicted file",
        nextHint: "Next conflicted file",
      }}
      colors={GIT_REVIEW_NAVIGATION_COLORS}
    />
  );
}
