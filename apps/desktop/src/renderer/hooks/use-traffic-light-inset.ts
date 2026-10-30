import { useEffect, useState } from "react";
import { isDesktop } from "@/lib/desktop/bridge";
import { getCurrentWindow } from "@/lib/desktop/window";

function readBaseInset() {
  if (!navigator.userAgent.includes("Macintosh")) return 0;
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(
      "--traffic-light-width",
    ),
  );
  return Number.isFinite(value) ? value : 0;
}

export function useTrafficLightInset() {
  const [inset, setInset] = useState(readBaseInset);
  useEffect(() => {
    if (!navigator.userAgent.includes("Macintosh") || !isDesktop()) {
      setInset(readBaseInset());
      return;
    }
    let mounted = true;
    let revision = 0;
    const appWindow = getCurrentWindow();
    const sync = async () => {
      const current = ++revision;
      try {
        const fullscreen = await appWindow.isFullscreen();
        if (mounted && current === revision)
          setInset(fullscreen ? 0 : readBaseInset());
      } catch {
        if (mounted && current === revision) setInset(readBaseInset());
      }
    };
    void sync();
    window.addEventListener("resize", sync);
    let unlisten: (() => void) | undefined;
    void appWindow
      .onResized(() => void sync())
      .then((dispose) => {
        if (mounted) unlisten = dispose;
        else dispose();
      })
      .catch(() => {});
    return () => {
      mounted = false;
      window.removeEventListener("resize", sync);
      unlisten?.();
    };
  }, []);
  return inset;
}
