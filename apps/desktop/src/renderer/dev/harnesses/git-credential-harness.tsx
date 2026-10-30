import { useState } from "react";
import { Button } from "@/components/ui/button";
import { GitCredentialDialog } from "@/components/workspace/git-credential-dialog";

const hosts = {
  overleaf: { name: "Overleaf", host: "git.overleaf.com", username: "git" },
  github: { name: "GitHub", host: "github.com", username: "alex" },
  custom: { name: "git.example.org", host: "git.example.org", username: "" },
};
type Host = keyof typeof hosts;

export function GitCredentialHarness() {
  const initial = new URLSearchParams(window.location.search).get("host");
  const [host, setHost] = useState<Host>(
    initial === "github" || initial === "custom" ? initial : "overleaf",
  );
  const [open, setOpen] = useState(true);
  const [success, setSuccess] = useState(false);
  const [reject, setReject] = useState(true);
  const [dark, setDark] = useState(false);
  const provider = hosts[host];
  const show = (next: Host) => {
    setHost(next);
    setSuccess(false);
    setOpen(true);
  };
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <div className="mx-auto max-w-2xl space-y-5 pt-12">
        <h1 className="font-semibold text-xl">Git credential popup</h1>
        <p className="text-muted-foreground text-sm">
          Visual demo only. No credentials are sent or saved. Close the popup to
          change the preview.
        </p>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(hosts) as Host[]).map((key) => (
            <Button key={key} variant="outline" onClick={() => show(key)}>
              {hosts[key].name}
            </Button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={reject}
            onChange={(event) => setReject(event.target.checked)}
          />
          Simulate rejected credentials
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={dark}
            onChange={(event) => {
              setDark(event.target.checked);
              document.documentElement.classList.toggle(
                "dark",
                event.target.checked,
              );
            }}
          />
          Dark appearance
        </label>
        {success && (
          <p role="status" className="text-sm">
            Demo complete: credentials saved and push retried.
          </p>
        )}
      </div>
      {open && (
        <GitCredentialDialog
          key={host}
          request={{
            id: "demo",
            projectRoot: "/demo",
            host: provider.host,
            provider: host === "custom" ? "Git over HTTPS" : provider.name,
            username: provider.username,
            action: "Push",
            remoteBranch: "origin/main",
            commands: ["git credential approve", "git push origin main"],
          }}
          onCancel={() => setOpen(false)}
          onSubmit={async () => {
            await new Promise((resolve) => setTimeout(resolve, 700));
            if (reject)
              throw new Error(
                "Authentication failed. Check your username and token, and make sure they have access to this repository.",
              );
            setSuccess(true);
            setOpen(false);
          }}
        />
      )}
    </main>
  );
}
