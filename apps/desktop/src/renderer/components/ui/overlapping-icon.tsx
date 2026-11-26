import type { LucideIcon } from "lucide-react";
import { useId } from "react";

export function OverlappingIcon({
  icon: Icon,
  nextIcon: NextIcon,
  maskClassName,
}: {
  icon: LucideIcon;
  nextIcon: LucideIcon;
  maskClassName: string;
}) {
  const id = useId();
  return (
    <svg
      className="size-3.5 overflow-visible"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <defs>
        <mask
          id={id}
          maskUnits="userSpaceOnUse"
          x="-4"
          y="-4"
          width="32"
          height="32"
          style={{ maskType: "luminance" }}
        >
          <rect x="-4" y="-4" width="32" height="32" fill="white" />
          {/* A 14px icon with an 8px step leaves a 6px overlap. */}
          <NextIcon
            className="size-6"
            x={(8 * 24) / 14}
            y={0}
            width={24}
            height={24}
            fill="black"
            stroke="black"
            strokeWidth={5}
          />
        </mask>
      </defs>
      <g className={maskClassName} mask={`url(#${id})`}>
        <Icon className="size-6" width={24} height={24} />
      </g>
    </svg>
  );
}
