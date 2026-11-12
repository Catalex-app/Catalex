import { CheckCheckIcon, ThumbsUpIcon, type LucideIcon } from "lucide-react";
import type { AgentExecutionMode } from "@/stores/settings-store";

export const AGENT_EXECUTION_MODES: Record<
  AgentExecutionMode,
  {
    value: AgentExecutionMode;
    label: string;
    description: string;
    icon: LucideIcon;
    labelClassName?: string;
  }
> = {
  default: {
    value: "default",
    label: "Need approval",
    description: "Review changes before applying.",
    icon: ThumbsUpIcon,
  },
  edit: {
    value: "edit",
    label: "Auto-apply",
    description:
      "Apply clean changes automatically. Pause on conflicts or errors.",
    icon: CheckCheckIcon,
    labelClassName: "text-purple-700 dark:text-purple-300",
  },
};
