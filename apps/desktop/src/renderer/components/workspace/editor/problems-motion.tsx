import { type ReactNode, useLayoutEffect, useRef } from "react";
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
  const motionRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const motion = motionRef.current;
    const content = contentRef.current;
    if (kind !== "bar" || !motion || !content) return;

    const updateHeight = () => {
      motion.style.setProperty(
        "--problems-motion-height",
        `${content.offsetHeight}px`,
      );
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(content);
    return () => observer.disconnect();
  }, [kind]);

  return (
    <div
      ref={motionRef}
      className={`problems-motion problems-motion--${kind} ${className}`}
      data-problems-motion={kind}
      data-open={open}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="problems-motion-clip">
        <div ref={contentRef} className="problems-motion-content">
          {children}
        </div>
      </div>
    </div>
  );
}
