import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import "./sonner.css";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      closeButton
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <CircleAlertIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        style: {
          backdropFilter: "var(--popup-surface-filter, none)",
          boxShadow: "var(--popup-surface-shadow, 0 4px 12px #0000001a)",
        },
      }}
      style={
        {
          "--normal-bg": "var(--popup-surface-background, var(--popover))",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--popup-surface-border, var(--border))",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
