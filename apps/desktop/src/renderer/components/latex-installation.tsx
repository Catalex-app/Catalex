import { MissingInstallationCard } from "@/components/missing-installation-card";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";
import { SettingsDropdown } from "@/components/settings/settings-dropdown";
import { type ReactNode, useEffect, useState } from "react";
import { detectTexlive, type TexliveStatus } from "@/lib/latex-compiler";
import { useSettingsStore } from "@/stores/settings-store";
import { SettingsRow } from "@/components/settings/settings-layout";
import { open } from "@/lib/desktop/shell";

export function LatexInstallationControl({
  status,
  recommendationOnly = false,
  actions,
}: {
  status?: TexliveStatus | null;
  recommendationOnly?: boolean;
  actions?: ReactNode;
}) {
  const [detected, setDetected] = useState<TexliveStatus | null>(null);
  const [error, setError] = useState(false);
  const selected = useSettingsStore((s) => s.latexInstallation);
  const select = useSettingsStore((s) => s.setLatexInstallation);
  useEffect(() => {
    if (status === undefined)
      void detectTexlive()
        .then(setDetected)
        .catch(() => setError(true));
  }, [status]);
  const result = status === undefined ? detected : status;
  const installs = result?.installations ?? [];
  const active = installs.find((i) => i.id === selected);
  useEffect(() => {
    if (!selected && installs.length)
      select((installs.find((i) => i.available) ?? installs[0]).id);
  }, [installs, selected, select]);
  const mac = /Mac/i.test(navigator.platform);
  const windows = /Win/i.test(navigator.platform);
  const links = mac
    ? [
        ["MacTeX (recommended)", "https://tug.org/mactex/mactex-download.html"],
        ["MiKTeX", "https://miktex.org/download"],
      ]
    : windows
      ? [
          ["MiKTeX (recommended)", "https://miktex.org/download"],
          ["TeX Live", "https://tug.org/texlive/windows.html"],
        ]
      : [
          [
            "TeX Live (recommended)",
            "https://tug.org/texlive/quickinstall.html",
          ],
          ["MiKTeX", "https://miktex.org/download"],
        ];
  if (error)
    return (
      <p className="py-2 text-muted-foreground text-sm">
        Could not check installations.
      </p>
    );
  if (!result) return null;
  return (
    <>
      {!recommendationOnly && installs.length > 0 && (
        <SettingsRow title="Installation">
          <SettingsDropdown
            ariaLabel="LaTeX installation"
            value={selected ?? ""}
            onChange={select}
            options={[
              ...(selected && !installs.some((i) => i.id === selected)
                ? [{ value: selected, label: "Saved installation unavailable" }]
                : []),
              ...installs.map((i) => ({
                value: i.id,
                label: `${i.name} — ${i.id}${i.available ? "" : " (missing tools)"}`,
              })),
            ]}
          />
        </SettingsRow>
      )}
      {(recommendationOnly ||
        !result.available ||
        (selected && !active?.available)) && (
        <MissingInstallationCard
          title="LaTeXmk is not installed."
          description={
            !recommendationOnly && installs.length
              ? "Your installation is missing required tools. Add latexmk and a LaTeX engine, then check again."
              : "Install LaTeX for broad package support and easier compiling of Overleaf projects."
          }
        >
          {links.slice(0, 1).map(([label, url], index) => (
            <Button
              key={url}
              variant={index === 0 ? "default" : "outline"}
              size="sm"
              asChild
            >
              <a
                href={url}
                className={
                  index === 0 ? "text-primary-foreground" : "text-foreground"
                }
                onClick={(event) => {
                  if (window.catalex) {
                    event.preventDefault();
                    void open(url);
                  }
                }}
              >
                <ExternalLink className="size-4" />
                Install {label.replace(" (recommended)", "")}
              </a>
            </Button>
          ))}
          {actions}
        </MissingInstallationCard>
      )}
    </>
  );
}
