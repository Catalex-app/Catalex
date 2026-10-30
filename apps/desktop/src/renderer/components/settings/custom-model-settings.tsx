import { Hint } from "@/components/ui/tooltip";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@/lib/desktop/core";
import {
  CheckIcon,
  Loader2Icon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSettingsStore } from "@/stores/settings-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { findClaudeModel } from "@/lib/claude-models";
import {
  customModelDisplayName,
  customModelIdError,
  type CustomModel,
} from "@/lib/custom-models";
import { broadcastSettingsChanged } from "./solar-mode-effect";

export function CustomModelSettings({
  provider,
}: {
  provider: CustomModel["provider"];
}) {
  const [adding, setAdding] = useState(false);
  const modelInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (adding) modelInput.current?.focus();
  }, [adding]);
  const models = useSettingsStore((s) => s.customModels);
  const add = useSettingsStore((s) => s.addCustomModel);
  const remove = useSettingsStore((s) => s.removeCustomModel);
  const claudeModels = useClaudeSetupStore((s) => s.models);
  const codexModels = useCodexSetupStore((s) => s.models);

  const [id, setId] = useState("");
  const [verified, setVerified] = useState<{
    id: string;
    displayName: string;
  } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verificationError, setVerificationError] = useState("");
  const requestVersion = useRef(0);
  useEffect(
    () => () => {
      requestVersion.current += 1;
    },
    [],
  );
  const resetVerification = () => {
    requestVersion.current += 1;
    setVerified(null);
    setVerifying(false);
    setVerificationError("");
  };
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState("");
  const trimmed = id.trim();
  const duplicate =
    models.some(
      (model) => model.provider === provider && model.id === trimmed,
    ) ||
    (provider === "claude"
      ? !!findClaudeModel(claudeModels, trimmed)
      : codexModels.some((model) => model.model === trimmed));
  const error =
    customModelIdError(id) ||
    (duplicate ? "This model is already available in the model picker." : null);
  const showError = (submitted || id.length > 0) && error;

  const providerModels = models.filter((model) => model.provider === provider);
  return (
    <div
      id="custom-model-configuration"
      className="min-w-0 divide-y divide-border/45"
    >
      {providerModels.length > 0 && (
        <ul className="divide-y divide-border/45">
          {providerModels.map((model) => (
            <li
              key={`${model.provider}:${model.id}`}
              className="flex min-h-11 items-center gap-3 py-2 pr-0.5"
            >
              <div className="min-w-0 flex-1 text-right">
                <Hint content={model.id}>
                  <div className="break-words text-sm">
                    {customModelDisplayName(model)}
                  </div>
                </Hint>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${model.id}`}
                onClick={() => {
                  const settings = useSettingsStore.getState();
                  if (
                    model.provider === "claude" &&
                    settings.defaultClaudeModel === model.id
                  ) {
                    settings.setDefaultClaudeModel(
                      claudeModels[0]?.value ?? "opus",
                    );
                  }
                  if (
                    model.provider === "codex" &&
                    settings.defaultCodexModel === model.id
                  ) {
                    settings.setDefaultCodexModel(
                      codexModels.find((item) => item.is_default)?.model ??
                        codexModels[0]?.model ??
                        "gpt-5.4",
                    );
                  }
                  remove(model.provider, model.id);
                  broadcastSettingsChanged();
                  setMessage(`Removed ${model.id}.`);
                }}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <form
          className="w-full space-y-3 py-3 pr-2"
          onSubmit={async (event) => {
            event.preventDefault();
            setSubmitted(true);
            setMessage("");
            if (error || verifying) return;
            if (!verified || verified.id !== trimmed) {
              const request = ++requestVersion.current;
              setVerifying(true);
              setVerificationError("");
              try {
                const result = await invoke<{
                  id: string;
                  displayName?: string;
                }>(`verify_${provider}_model`, { modelId: trimmed });
                if (request !== requestVersion.current) return;
                if (result.id !== trimmed)
                  throw new Error(
                    "The backend verified a different model. Please retry.",
                  );
                setVerified({
                  id: trimmed,
                  displayName: customModelDisplayName({ provider, ...result }),
                });
              } catch (error) {
                if (request !== requestVersion.current) return;
                setVerificationError(
                  String(error).replace(/^Error: /, "") ||
                    "Could not verify this model. Please retry.",
                );
              } finally {
                if (request === requestVersion.current) setVerifying(false);
              }
              return;
            }
            add({
              provider,
              id: trimmed,
              displayName: verified.displayName,
              effort: provider === "claude" ? "default" : "medium",
            });
            broadcastSettingsChanged();
            setMessage(
              `Added ${trimmed} to the ${provider === "claude" ? "Claude" : "Codex"} model picker.`,
            );
            setId("");
            setSubmitted(false);
            setAdding(false);
          }}
        >
          <div className="space-y-1.5">
            <Input
              ref={modelInput}
              id="custom-model-id"
              aria-label="Model ID"
              value={id}
              maxLength={200}
              placeholder={
                provider === "claude"
                  ? "Enter model ID, e.g. claude-opus-4-6"
                  : "Enter model ID, e.g. gpt-5.4"
              }
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!showError || !!verificationError}
              aria-describedby={
                showError
                  ? "custom-model-error"
                  : verificationError
                    ? "custom-model-verification-error"
                    : undefined
              }
              className="h-8 w-full bg-background text-left font-mono text-xs"
              onChange={(event) => {
                resetVerification();
                setId(event.target.value);
                setMessage("");
              }}
            />
            {showError && (
              <p
                id="custom-model-error"
                role="alert"
                className="text-destructive text-xs"
              >
                {error}
              </p>
            )}
          </div>
          {verificationError && (
            <p
              id="custom-model-verification-error"
              role="alert"
              className="break-words text-destructive text-xs"
            >
              {verificationError}
            </p>
          )}
          {verified && (
            <div
              role="status"
              className="flex items-center justify-between gap-3 border-border/45 border-t pt-3 text-sm"
            >
              <span className="text-muted-foreground">Model</span>
              <span className="flex min-w-0 items-center gap-2">
                <CheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span className="break-words">{verified.displayName}</span>
              </span>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 text-xs"
              onClick={() => {
                resetVerification();
                setAdding(false);
                setMessage("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={verifying}
              aria-busy={verifying}
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
            >
              {verifying ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : verified ? (
                <SaveIcon className="size-3.5" />
              ) : (
                <CheckIcon className="size-3.5" />
              )}
              {verifying ? "Verifying…" : verified ? "Save" : "Verify"}
            </Button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="flex w-full items-center justify-end gap-2 py-3 pr-2 text-right font-medium text-muted-foreground text-sm transition-colors hover:text-foreground"
          onClick={() => {
            resetVerification();
            setId("");
            setSubmitted(false);
            setMessage("");
            setAdding(true);
          }}
        >
          <PlusIcon className="size-4" />
          Add New
        </button>
      )}
      {message && (
        <p
          role="status"
          className="break-words py-3 text-muted-foreground text-xs"
        >
          {message}
        </p>
      )}
    </div>
  );
}
