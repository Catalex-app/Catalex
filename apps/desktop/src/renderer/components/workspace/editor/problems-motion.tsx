import type { ReactNode } from "react";
import "./problems-motion.css";

/** Keep the content mounted so closing can animate and preserve the selected issue. */
export function ProblemsMotion({
  open,
  kind,
  children,
  className = "",
}: {
  open: boolean;
  kind: "bar" | "button";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`problems-motion problems-motion--${kind} ${className}`}
      data-problems-motion={kind}
      data-open={open}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="problems-motion-clip">
        <div className="problems-motion-content">{children}</div>
      </div>
    </div>
  );
}
