import { usePiSetupStore } from "@/stores/pi-setup-store";
import { usePiPathSettings } from "@/hooks/use-pi-path-settings";
import {
  findPiModel,
  piModelThinkingLevels,
  resolvePiThinkingLevel,
  piModelValue,
  piModelLabel,
} from "@/lib/pi-models";
import { PRODUCT_NAME } from "../../branding";
import { ProviderToggle } from "./provider-toggle";
import { finishWithCatHandoff } from "@/lib/cat-handoff";
import { MissingInstallationCard } from "@/components/missing-installation-card";
import { OnboardingTitle } from "@/components/onboarding-title";
import { OnboardingCatSettings } from "@/components/onboarding-cat-settings";
import { LatexInstallationControl } from "@/components/latex-installation";
import { Hint } from "@/components/ui/tooltip";
import { claudeModelEfforts } from "@/lib/claude-models";
import { codexEffortLabel } from "@/lib/codex-models";
import {
  SettingsGroup,
  SettingsRow,
} from "@/components/settings/settings-layout";
import {
  SettingsDropdown,
  COMPILER_OPTIONS,
  COMPILER_ENGINE_OPTIONS,
  AGENT_OPTIONS,
  SettingsSwitch,
  FALLBACK_CODEX_REASONING_OPTIONS,
} from "@/components/settings/settings-window";
import { OnboardingAppearance } from "@/components/onboarding-appearance";
import {
  CatCompanion,
  HANDWRITTEN_CAT_FONT,
} from "@/components/workspace/sidebar";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  FileText,
  Check,
  GitBranch,
  MessageCircle,
  LoaderCircle,
  CircleHelp,
  AlertCircle,
  CircleX,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { ClaudeSetup } from "@/components/claude-setup";
import { CodexSetup } from "@/components/codex-setup";
import { useSettingsStore } from "@/stores/settings-store";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { detectTexlive, type TexliveStatus } from "@/lib/latex-compiler";
import { cn } from "@/lib/utils";

const steps = [
  "Welcome",
  "Get comfortable",
  "A little setup",
  "Ah, almost forgot",
];

export function Onboarding() {
  const { step, setStep, finish } = useOnboardingStore();
  const previousStep = useRef(step);
  const slideDirection = useRef(1);
  if (step !== previousStep.current)
    slideDirection.current = step > previousStep.current ? 1 : -1;
  useEffect(() => {
    previousStep.current = step;
  }, [step]);
  const settings = useSettingsStore();
  const claude = useClaudeSetupStore();
  const codex = useCodexSetupStore();
  const pi = usePiSetupStore();
  const piPathSettings = usePiPathSettings();
  const [detectedLatex, setLatex] = useState<TexliveStatus | null>(null);
  const selectedInstallation = detectedLatex?.installations?.find(
    (i) => i.id === settings.latexInstallation,
  );
  const latex = selectedInstallation
    ? {
        ...detectedLatex,
        ...selectedInstallation,
        latexmkAvailable: Boolean(selectedInstallation.binaryPaths.latexmk),
      }
    : settings.latexInstallation && detectedLatex?.installations?.length
      ? {
          ...detectedLatex,
          available: false,
          version: null,
          binaryPaths: {},
          engines: [],
        }
      : detectedLatex;
  const [latexError, setLatexError] = useState("");
  const [checking, setChecking] = useState(true);
  const heading = useRef<HTMLHeadingElement>(null);
  async function checkLatex() {
    setChecking(true);
    setLatexError("");
    try {
      setLatex(await detectTexlive());
    } catch (error) {
      setLatexError(String(error));
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    void checkLatex();
    void useClaudeSetupStore.getState().checkStatus();
    void useCodexSetupStore.getState().checkStatus();
    void usePiSetupStore.getState().checkStatus();
  }, []);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.closest("main")?.scrollTo({ top: 0 });
  }, [step]);
  const [provider, setProvider] = useState(settings.defaultAgent);
  const [backend, setBackend] = useState(settings.compilerBackend);
  const agent = provider === "pi" ? pi : provider === "claude" ? claude : codex;
  const noAgentAvailable =
    claude.status !== "ready" &&
    codex.status !== "ready" &&
    pi.status !== "ready";
  const models =
    provider === "pi"
      ? pi.models.map((m) => ({
          value: piModelValue(m),
          label: piModelLabel(piModelValue(m), pi.models),
        }))
      : provider === "claude"
        ? claude.models.map((m) => ({ value: m.value, label: m.displayName }))
        : codex.models.map((m) => ({ value: m.model, label: m.display_name }));
  const model =
    provider === "pi"
      ? settings.defaultPiModel
      : provider === "claude"
        ? settings.defaultClaudeModel
        : settings.defaultCodexModel;
  const setModel =
    provider === "pi"
      ? settings.setDefaultPiModel
      : provider === "claude"
        ? settings.setDefaultClaudeModel
        : settings.setDefaultCodexModel;
  const piModelInfo = findPiModel(pi.models, settings.defaultPiModel);
  const piEffortOptions = piModelInfo?.reasoning
    ? piModelThinkingLevels(piModelInfo)
    : [];
  const piEffort = resolvePiThinkingLevel(
    piModelInfo,
    settings.defaultPiReasoningEffort,
  );
  useEffect(() => {
    if (
      piEffort !== undefined &&
      piEffort !== settings.defaultPiReasoningEffort
    ) {
      settings.setDefaultPiReasoningEffort(piEffort);
    }
  }, [
    piEffort,
    settings.defaultPiReasoningEffort,
    settings.setDefaultPiReasoningEffort,
  ]);
  useEffect(() => {
    const efforts = claudeModelEfforts(
      claude.models.find((m) => m.value === settings.defaultClaudeModel),
    );
    if (
      efforts.length &&
      !efforts.includes(settings.defaultClaudeEffortLevel)
    ) {
      settings.setDefaultClaudeEffortLevel(
        efforts.includes("medium") ? "medium" : efforts[0],
      );
    }
    const codexModel = codex.models.find(
      (m) => m.model === settings.defaultCodexModel,
    );
    const reasoning = codexModel?.supported_reasoning_efforts;
    if (
      reasoning?.length &&
      !reasoning.some((e) => e.value === settings.defaultCodexReasoningEffort)
    ) {
      settings.setDefaultCodexReasoningEffort(
        codexModel?.default_reasoning_effort || reasoning[0].value,
      );
    }
  }, [
    claude.models,
    codex.models,
    settings.defaultClaudeModel,
    settings.defaultClaudeEffortLevel,
    settings.defaultCodexModel,
    settings.defaultCodexReasoningEffort,
    settings.setDefaultClaudeEffortLevel,
    settings.setDefaultCodexReasoningEffort,
  ]);

  return (
    <main
      className="relative flex h-dvh items-center justify-center bg-background text-foreground"
      data-testid="onboarding"
    >
      <div
        data-window-drag-region
        aria-hidden="true"
        className="absolute inset-x-0 top-0 z-20 h-8"
      />
      <div
        data-testid="onboarding-frame"
        className="relative flex h-[min(100dvh,720px)] w-full max-w-[1536px] flex-col overflow-hidden"
      >
        <div
          className={cn(
            "mx-auto flex min-h-0 w-full max-w-[1536px] flex-1 flex-col overflow-auto px-6 py-8 sm:px-12",
            step === 1 && "pb-16",
          )}
        >
          <section
            key={step}
            style={
              {
                "--onboarding-slide-x": `${slideDirection.current * 24}px`,
              } as React.CSSProperties
            }
            aria-labelledby="onboarding-title"
            className={cn(
              "onboarding-page-enter shrink-0",
              step === 1 && "lg:flex lg:min-h-0 lg:flex-1 lg:flex-col",
              step === 0 ? "my-auto text-center" : "min-h-[350px]",
            )}
          >
            {step !== 1 && step !== 3 && (
              <h1
                id="onboarding-title"
                ref={heading}
                tabIndex={-1}
                className={cn(
                  "font-semibold text-4xl tracking-tight outline-none",
                  step === 0 && "sm:text-5xl",
                )}
              >
                {step === 0 ? (
                  <>
                    <span className="text-zinc-600 dark:text-zinc-400">
                      <OnboardingTitle text="Welcome to" />
                    </span>{" "}
                    <span style={{ fontFamily: HANDWRITTEN_CAT_FONT }}>
                      <OnboardingTitle text={PRODUCT_NAME + "."} offset={11} />
                    </span>
                  </>
                ) : (
                  <OnboardingTitle text={`${steps[step]}.`} />
                )}
              </h1>
            )}
            {step === 0 && (
              <div className="mx-auto mt-12 grid max-w-4xl gap-5 sm:grid-cols-3">
                {[
                  {
                    icon: FileText,
                    title: "Built for research",
                    text: "A workspace for CS and math researchers to write papers in LaTeX and Markdown.",
                  },
                  {
                    icon: GitBranch,
                    title: "Stay in sync",
                    text: "Sync your writing with Overleaf, GitHub, or any Git remote.",
                  },
                  {
                    icon: MessageCircle,
                    title: "Bring your agent",
                    text: "Connect Claude or Codex through its CLI and use your existing subscription.",
                  },
                ].map(({ icon: Icon, title, text }) => (
                  <div
                    key={title}
                    className="rounded-2xl border border-border bg-background p-6 text-left"
                  >
                    <Icon className="mb-5 size-6" strokeWidth={1.4} />
                    <div>
                      <h2 className="font-medium">{title}</h2>
                      <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
                        {text}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {step === 1 && <OnboardingAppearance />}
            {step === 2 && (
              <div className="relative mt-12 grid grid-cols-1 items-start gap-10 lg:grid-cols-2 lg:gap-16 lg:before:pointer-events-none lg:before:absolute lg:before:inset-y-0 lg:before:left-1/2 lg:before:w-px lg:before:bg-border/60">
                <section
                  aria-label="LaTeX setup"
                  className="min-w-0 self-stretch"
                >
                  <h2 className="mb-3 font-medium text-lg">LaTeX backend</h2>
                  <ButtonGroup
                    role="tablist"
                    aria-label="LaTeX backend"
                    className="mb-4 flex h-9 w-fit items-center gap-1"
                  >
                    {COMPILER_OPTIONS.map((option) => {
                      const busy = option.value === "latexmk" && checking;
                      const failed =
                        option.value === "latexmk" && Boolean(latexError);
                      const ready =
                        option.value === "tectonic" ||
                        (!checking && !latexError && Boolean(latex?.available));
                      return (
                        <Hint
                          key={option.value}
                          content={
                            <span className="block whitespace-nowrap">
                              {option.value === "latexmk"
                                ? "Install required · Supports most templates"
                                : "Built in · Supports fewer templates"}
                            </span>
                          }
                        >
                          <button
                            type="button"
                            role="tab"
                            id={`onboarding-backend-${option.value}`}
                            aria-controls="onboarding-backend-panel"
                            aria-selected={backend === option.value}
                            className={cn(
                              "flex h-7 items-center gap-2 rounded-md px-3 font-medium text-sm focus-visible:outline-2 focus-visible:outline-ring",
                              backend === option.value
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:bg-background/70",
                            )}
                            onClick={() => setBackend(option.value)}
                          >
                            <span
                              role="img"
                              aria-label={
                                busy
                                  ? "Checking"
                                  : option.value === "tectonic"
                                    ? "Bundled"
                                    : ready
                                      ? "Ready"
                                      : "Needs setup"
                              }
                              className={cn(
                                "flex size-4 items-center justify-center rounded-full border",
                                ready
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                                  : busy
                                    ? "border-muted-foreground/40 text-muted-foreground"
                                    : failed
                                      ? "border-transparent text-destructive"
                                      : "border-transparent text-amber-600 dark:text-amber-500",
                              )}
                            >
                              {busy ? (
                                <LoaderCircle className="size-3 animate-spin" />
                              ) : ready ? (
                                <Check className="size-3" />
                              ) : failed ? (
                                <CircleX className="size-4 shrink-0" />
                              ) : (
                                <AlertCircle className="size-4 shrink-0" />
                              )}
                            </span>
                            {option.label}
                            <CircleHelp
                              aria-hidden="true"
                              className="size-3.5 text-muted-foreground"
                            />
                          </button>
                        </Hint>
                      );
                    })}
                  </ButtonGroup>
                  <div
                    role="tabpanel"
                    id="onboarding-backend-panel"
                    aria-labelledby={`onboarding-backend-${backend}`}
                    className="min-w-0"
                  >
                    {backend === "latexmk" && latexError ? (
                      <MissingInstallationCard
                        tone="error"
                        title="LaTeX check failed"
                        description="We couldn’t check your LaTeX installation. Please try again."
                      >
                        <Button
                          size="sm"
                          disabled={checking}
                          onClick={() => void checkLatex()}
                        >
                          <RefreshCw className="size-4" />
                          Recheck
                        </Button>
                      </MissingInstallationCard>
                    ) : backend === "latexmk" && !latex?.available ? (
                      <LatexInstallationControl
                        status={detectedLatex}
                        recommendationOnly
                        actions={
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={checking}
                            onClick={() => void checkLatex()}
                          >
                            <RefreshCw
                              className={cn(
                                "size-4",
                                checking && "animate-spin",
                              )}
                            />
                            {checking ? "Checking…" : "Recheck"}
                          </Button>
                        }
                      />
                    ) : (
                      <>
                        <SettingsGroup>
                          <SettingsRow
                            title={`Use ${backend === "latexmk" ? "LaTeXmk" : "Tectonic"} by default`}
                          >
                            <SettingsSwitch
                              label="Default backend"
                              checked={settings.compilerBackend === backend}
                              onCheckedChange={(checked) =>
                                settings.setCompilerBackend(
                                  checked
                                    ? backend
                                    : backend === "latexmk"
                                      ? "tectonic"
                                      : "latexmk",
                                )
                              }
                            />
                          </SettingsRow>
                          {backend === "latexmk" && (
                            <>
                              <LatexInstallationControl
                                status={detectedLatex}
                              />
                              <SettingsRow title="Local installation">
                                <div className="flex min-w-0 items-center justify-end gap-1.5">
                                  <span
                                    role="status"
                                    className="min-w-0 break-words font-sans text-muted-foreground text-xs"
                                  >
                                    {checking
                                      ? "Checking local LaTeX…"
                                      : latexError
                                        ? "Check failed"
                                        : latex?.available
                                          ? (latex.version ??
                                            "Version unavailable")
                                          : "Local LaTeX is not available"}
                                  </span>
                                  {latex?.binaryPaths &&
                                    Object.keys(latex.binaryPaths).length >
                                      0 && (
                                      <Hint
                                        content={[
                                          ...new Set(
                                            Object.values(
                                              latex.binaryPaths,
                                            ).map((path) =>
                                              path.replace(/[\\/][^\\/]+$/, ""),
                                            ),
                                          ),
                                        ].join(" · ")}
                                      >
                                        <button
                                          type="button"
                                          aria-label="Installation folder"
                                          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                                        >
                                          <FolderOpen className="size-4" />
                                        </button>
                                      </Hint>
                                    )}
                                  <Hint content="Check again">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-7 shrink-0"
                                      aria-label="Check again"
                                      disabled={checking}
                                      onClick={() => void checkLatex()}
                                    >
                                      <RefreshCw
                                        className={cn(
                                          "size-4",
                                          checking && "animate-spin",
                                        )}
                                      />
                                    </Button>
                                  </Hint>
                                </div>
                              </SettingsRow>
                              {latexError && (
                                <p
                                  role="alert"
                                  className="py-2 text-muted-foreground text-sm"
                                >
                                  Could not check local LaTeX. Try again, or
                                  choose bundled Tectonic.
                                </p>
                              )}
                              {!checking && !latex?.available && (
                                <div className="flex items-center justify-between gap-4 py-2">
                                  <p className="text-muted-foreground text-sm">
                                    Use bundled Tectonic—no installation needed.
                                  </p>
                                  {settings.compilerBackend !== "tectonic" && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => setBackend("tectonic")}
                                    >
                                      View Tectonic
                                    </Button>
                                  )}
                                </div>
                              )}
                              <SettingsRow title="Preferred engine">
                                <SettingsDropdown
                                  ariaLabel="Preferred engine"
                                  value={settings.compilerEngine}
                                  options={COMPILER_ENGINE_OPTIONS}
                                  onChange={settings.setCompilerEngine}
                                />
                              </SettingsRow>
                            </>
                          )}
                        </SettingsGroup>
                        {backend === "tectonic" && (
                          <p className="mt-2 text-muted-foreground text-xs">
                            Tectonic is bundled. First compile may download
                            packages.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </section>
                <section
                  aria-label="Agent setup"
                  className="min-w-0 self-stretch"
                >
                  <h2 className="mb-3 font-medium text-lg">Agent provider</h2>
                  <ButtonGroup
                    role="tablist"
                    aria-label="Agent provider"
                    className="mb-4 flex h-9 w-fit items-center gap-1"
                  >
                    {AGENT_OPTIONS.map((option) => {
                      const failed =
                        (option.value === "pi"
                          ? pi
                          : option.value === "claude"
                            ? claude
                            : codex
                        ).status === "error";
                      const ready =
                        (option.value === "pi"
                          ? pi
                          : option.value === "claude"
                            ? claude
                            : codex
                        ).status === "ready";
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="tab"
                          id={`onboarding-agent-${option.value}`}
                          aria-controls="onboarding-agent-panel"
                          aria-selected={provider === option.value}
                          className={cn(
                            "flex h-7 items-center gap-2 rounded-md px-3 font-medium text-sm focus-visible:outline-2 focus-visible:outline-ring",
                            provider === option.value
                              ? "bg-background text-foreground shadow-sm"
                              : "text-muted-foreground hover:bg-background/70",
                          )}
                          onClick={() => setProvider(option.value)}
                        >
                          <span
                            role="img"
                            aria-label={
                              !settings.enabledProviders[option.value]
                                ? "Disabled"
                                : ready
                                  ? "Ready"
                                  : "Needs setup"
                            }
                            className={cn(
                              "flex size-4 items-center justify-center rounded-full border",
                              !settings.enabledProviders[option.value]
                                ? "border-muted-foreground/30 text-muted-foreground"
                                : ready
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                                  : failed
                                    ? "border-transparent text-destructive"
                                    : "border-transparent text-amber-600 dark:text-amber-500",
                            )}
                          >
                            {!settings.enabledProviders[option.value] ? (
                              <span className="h-px w-2 bg-current" />
                            ) : ready ? (
                              <Check className="size-3" />
                            ) : failed ? (
                              <CircleX className="size-4 shrink-0" />
                            ) : (
                              <AlertCircle className="size-4 shrink-0" />
                            )}
                          </span>
                          {option.label}
                        </button>
                      );
                    })}
                  </ButtonGroup>
                  <div
                    role="tabpanel"
                    id="onboarding-agent-panel"
                    aria-labelledby={`onboarding-agent-${provider}`}
                    className="min-w-0"
                  >
                    <ProviderToggle provider={provider} />
                    {settings.enabledProviders[provider] &&
                      (agent.status !== "ready" ||
                        (provider === "pi" &&
                          (pi.error || pi.modelsError))) && (
                        <div className="mb-4">
                          {provider === "pi" ? (
                            <p
                              role="status"
                              className="text-muted-foreground text-sm"
                            >
                              {pi.status === "checking"
                                ? "Checking Pi…"
                                : (pi.error ??
                                  pi.modelsError ??
                                  "Install and configure Pi in your terminal.")}{" "}
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={
                                  pi.status === "checking" ||
                                  pi.modelsStatus === "loading"
                                }
                                onClick={() => void pi.checkStatus()}
                              >
                                Check again
                              </Button>
                            </p>
                          ) : provider === "claude" ? (
                            <ClaudeSetup />
                          ) : (
                            <CodexSetup />
                          )}
                        </div>
                      )}
                    <SettingsGroup>
                      {provider === "pi" &&
                        settings.enabledProviders.pi &&
                        piPathSettings.map((field) => (
                          <SettingsRow
                            key={field.id}
                            id={field.id}
                            title={field.title}
                          >
                            <SettingsDropdown {...field.dropdown} />
                          </SettingsRow>
                        ))}
                      {settings.enabledProviders[provider] &&
                        agent.status !== "not-installed" && (
                          <SettingsRow
                            title={`Use ${provider === "pi" ? "Pi" : provider === "claude" ? "Claude Code" : "Codex"} by default`}
                          >
                            <SettingsSwitch
                              label="Default provider"
                              checked={settings.defaultAgent === provider}
                              onCheckedChange={(checked) =>
                                settings.setDefaultAgent(
                                  checked
                                    ? provider
                                    : (AGENT_OPTIONS.find(
                                        (option) =>
                                          option.value !== provider &&
                                          settings.enabledProviders[
                                            option.value
                                          ],
                                      )?.value ?? provider),
                                )
                              }
                            />
                          </SettingsRow>
                        )}
                      {agent.status === "ready" && (
                        <SettingsRow title="Default model">
                          <SettingsDropdown
                            ariaLabel="Default model"
                            value={model}
                            onChange={setModel}
                            disabled={
                              provider === "pi" && pi.modelsStatus !== "ready"
                            }
                            placeholder={
                              provider === "pi" && pi.modelsStatus === "loading"
                                ? "Loading models…"
                                : "Select…"
                            }
                            options={[
                              ...(model
                                ? [
                                    {
                                      value: model,
                                      label:
                                        models.find((m) => m.value === model)
                                          ?.label ?? `${model} (saved default)`,
                                    },
                                  ]
                                : []),
                              ...models.filter((m) => m.value !== model),
                            ]}
                          />
                        </SettingsRow>
                      )}
                      {agent.status === "ready" &&
                        provider === "claude" &&
                        claudeModelEfforts(
                          claude.models.find((m) => m.value === model),
                        ).length > 0 && (
                          <SettingsRow title="Thinking level">
                            <SettingsDropdown
                              ariaLabel="Thinking level"
                              value={settings.defaultClaudeEffortLevel}
                              onChange={settings.setDefaultClaudeEffortLevel}
                              options={claudeModelEfforts(
                                claude.models.find((m) => m.value === model),
                              ).map((value) => ({
                                value,
                                label:
                                  value === "xhigh"
                                    ? "Extra High"
                                    : value[0].toUpperCase() + value.slice(1),
                              }))}
                            />
                          </SettingsRow>
                        )}
                      {agent.status === "ready" && provider === "codex" && (
                        <SettingsRow title="Thinking level">
                          <SettingsDropdown
                            ariaLabel="Thinking level"
                            value={settings.defaultCodexReasoningEffort}
                            onChange={settings.setDefaultCodexReasoningEffort}
                            options={
                              codex.models
                                .find((m) => m.model === model)
                                ?.supported_reasoning_efforts?.map(
                                  (effort) => ({
                                    value: effort.value,
                                    label: codexEffortLabel(effort.value),
                                  }),
                                ) ?? FALLBACK_CODEX_REASONING_OPTIONS
                            }
                          />
                        </SettingsRow>
                      )}
                      {agent.status === "ready" &&
                        provider === "pi" &&
                        piEffortOptions.length > 0 && (
                          <SettingsRow title="Thinking level">
                            <SettingsDropdown
                              ariaLabel="Thinking level"
                              value={
                                piEffort ?? settings.defaultPiReasoningEffort
                              }
                              onChange={settings.setDefaultPiReasoningEffort}
                              options={piEffortOptions.map((value) => ({
                                value,
                                label: codexEffortLabel(value),
                              }))}
                            />
                          </SettingsRow>
                        )}
                      {agent.modelsError && (
                        <p
                          role="status"
                          className="py-2 text-muted-foreground text-sm"
                        >
                          Could not load models.{" "}
                          <button
                            type="button"
                            className="underline"
                            onClick={() => void agent.refreshModels()}
                          >
                            Retry
                          </button>
                        </p>
                      )}
                    </SettingsGroup>
                  </div>
                </section>
              </div>
            )}
            {step === 3 && (
              <div className="grid items-start gap-8 sm:grid-cols-2">
                <div>
                  <h1
                    id="onboarding-title"
                    ref={heading}
                    tabIndex={-1}
                    className="mb-8 font-semibold text-4xl tracking-tight outline-none"
                  >
                    <OnboardingTitle text="Ah, almost forgot." />
                  </h1>
                  <OnboardingCatSettings />
                </div>
                <div
                  className="flex min-h-80 min-w-0 items-center justify-center overflow-hidden p-8 lg:min-h-[420px]"
                  role="img"
                  aria-label="Cat preview"
                >
                  <div className="scale-[2.2] lg:scale-[3.3]">
                    <CatCompanion />
                  </div>
                </div>
              </div>
            )}
          </section>
          {step === 0 ? (
            <div className="mt-8 flex items-center justify-center gap-3">
              <Button
                aria-label="Let’s get started"
                className="group relative h-12 w-12 gap-0 overflow-hidden rounded-full p-0 transition-[width] duration-300 ease-out hover:w-48 focus-visible:w-48 motion-reduce:transition-none"
                onClick={() => setStep(1)}
              >
                <span
                  aria-hidden="true"
                  className="absolute right-12 whitespace-nowrap opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
                >
                  Let’s get started
                </span>
                <span className="absolute right-0 flex size-12 items-center justify-center">
                  <ArrowRight className="size-5" />
                </span>
              </Button>
            </div>
          ) : null}
        </div>
        {step > 0 && (
          <footer className="relative grid shrink-0 grid-cols-[auto_1fr] items-center gap-y-2 bg-background px-6 py-4 sm:px-12">
            <nav
              aria-label="Setup progress"
              className="col-span-2 row-start-1 flex h-9 items-center gap-1 justify-self-center lg:absolute lg:left-1/2 lg:-translate-x-1/2"
            >
              {steps.slice(1).map((label, index) => (
                <button
                  key={label}
                  type="button"
                  aria-label={label}
                  aria-current={step === index + 1 ? "step" : undefined}
                  onClick={() => setStep(index + 1)}
                  className="flex h-9 items-center justify-center rounded-full px-1 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "block h-1 rounded-full",
                      step === index + 1
                        ? "w-10 bg-foreground"
                        : "w-1 bg-muted-foreground/35",
                    )}
                  />
                </button>
              ))}
            </nav>
            <Button
              variant="ghost"
              disabled={step === 0}
              onClick={() => setStep(step - 1)}
            >
              <ArrowLeft className="size-4" />
              Back
            </Button>
            <div className="flex items-center gap-2 justify-self-end">
              <Button variant="ghost" onClick={finish}>
                Skip for now
              </Button>
              <Button
                variant={step === 2 && noAgentAvailable ? "outline" : "default"}
                className={
                  step === 2 && noAgentAvailable
                    ? "bg-transparent dark:bg-transparent"
                    : undefined
                }
                onClick={() =>
                  step === 3 ? finishWithCatHandoff(finish) : setStep(step + 1)
                }
              >
                {step === 3
                  ? "Start writing"
                  : step === 2 && noAgentAvailable
                    ? "Continue (no agent available)"
                    : "Continue"}
                {step === 3 ? (
                  <Check className="size-4" />
                ) : (
                  <ArrowRight className="size-4" />
                )}
              </Button>
            </div>
          </footer>
        )}
      </div>
    </main>
  );
}
