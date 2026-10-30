import { useEffect, useState } from "react";
import {
  type AgentRoundTiming,
  formatRoundDuration,
  roundElapsed,
} from "@/lib/agent-round-timing";

export function RoundElapsedTime({ timing }: { timing: AgentRoundTiming }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (timing.runningSince == null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timing.runningSince]);
  return (
    <span className="ml-1 text-muted-foreground/60 text-xs">
      {formatRoundDuration(roundElapsed(timing, now))}
    </span>
  );
}
