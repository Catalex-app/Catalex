import { toolTitle } from "./tool-title";
import {
  type FC,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  ArrowUpIcon,
  BotMessageSquareIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  ClockIcon,
  FileEditIcon,
  FileIcon,
  FileOutputIcon,
  ListTodoIcon,
  LoaderIcon,
  MessageCircleQuestionIcon,
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import {
  useAgentChatStore,
  type ContentBlock,
} from "@/stores/agent-chat-store";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const WidgetStateKey = createContext<string | undefined>(undefined);
const expandedWidgets = new Map<string, boolean>();
function useExpanded(initial: boolean, explicitKey?: string) {
  const contextKey = useContext(WidgetStateKey);
  const key = explicitKey ?? contextKey;
  const [expanded, setExpanded] = useState(
    key ? (expandedWidgets.get(key) ?? initial) : initial,
  );
  return [
    expanded,
    (value: boolean) => {
      if (key) expandedWidgets.set(key, value);
      setExpanded(value);
    },
  ] as const;
}

interface ToolWidgetProps {
  stateKey?: string;
  toolUse: ContentBlock;
  toolResult?: ContentBlock;
}

export const ToolWidget: FC<ToolWidgetProps> = (props) => (
  <WidgetStateKey.Provider value={props.stateKey}>
    <ToolWidgetContent {...props} />
  </WidgetStateKey.Provider>
);
const ToolWidgetContent: FC<ToolWidgetProps> = ({ toolUse, toolResult }) => {
  const name = toolUse.name?.toLowerCase() || "";

  if (name === "write")
    return <WriteWidget input={toolUse.input} result={toolResult} />;
  if (name === "edit" || name === "multiedit")
    return <EditWidget input={toolUse.input} result={toolResult} />;
  if (name === "read")
    return <ReadWidget input={toolUse.input} result={toolResult} />;
  if (name === "bash")
    return <BashWidget input={toolUse.input} result={toolResult} />;
  if (name === "glob")
    return <GlobWidget input={toolUse.input} result={toolResult} />;
  if (name === "grep")
    return <GrepWidget input={toolUse.input} result={toolResult} />;
  if (name === "askuserquestion")
    return <AskUserQuestionWidget input={toolUse.input} result={toolResult} />;
  if (name === "todowrite")
    return <TodoWriteWidget input={toolUse.input} result={toolResult} />;

  return (
    <GenericWidget
      name={toolUse.name || "unknown"}
      input={toolUse.input}
      result={toolResult}
    />
  );
};

// ─── Status Icon ───

const StatusIcon: FC<{ result?: ContentBlock }> = ({ result }) => {
  const isStreaming = useAgentChatStore((s) => s.isStreaming);
  if (!result) {
    if (!isStreaming) {
      // Tool was cancelled (stop pressed) — show stopped state
      return <CircleIcon className="size-3.5 text-muted-foreground" />;
    }
    return (
      <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
    );
  }
  if (result.is_error) {
    return <span className="text-destructive text-sm">!</span>;
  }
  return <CheckIcon className="size-3.5 text-green-600" />;
};

// ─── Write Widget ───

const WriteWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
      <StatusIcon result={result} />
      <FileOutputIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground">
        {toolTitle({ type: "tool_use", name: "write", input }, result).label}{" "}
        <code className="rounded bg-muted px-1 text-xs">
          {input?.file_path}
        </code>
      </span>
    </div>
  );
};

// ─── Edit Widget ───

const EditWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  const [expanded, setExpanded] = useExpanded(false);

  return (
    <div className="my-1.5 rounded-lg border border-border bg-muted/50 text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2"
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon result={result} />
        <FileEditIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-muted-foreground">
          {toolTitle({ type: "tool_use", name: "edit", input }, result).label}{" "}
          <code className="rounded bg-muted px-1 text-xs">
            {input?.file_path}
          </code>
        </span>
        {(input?.old_string || input?.edits) &&
          (expanded ? (
            <ChevronDownIcon className="ml-auto size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="ml-auto size-3.5 text-muted-foreground" />
          ))}
      </button>
      {expanded && input?.old_string && (
        <div className="border-border border-t px-3 py-2 font-mono text-xs">
          <div className="mb-1 text-red-500">
            - {truncate(input.old_string, 200)}
          </div>
          <div className="text-green-500">
            + {truncate(input.new_string, 200)}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Read Widget ───

const ReadWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
      <StatusIcon result={result} />
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground">
        {toolTitle({ type: "tool_use", name: "read", input }, result).label}{" "}
        <code className="rounded bg-muted px-1 text-xs">
          {input?.file_path}
        </code>
      </span>
    </div>
  );
};

// ─── Bash Widget ───

const BashWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  const [expanded, setExpanded] = useExpanded(false);
  const title = toolTitle({ type: "tool_use", name: "bash", input }, result);
  const resultContent =
    typeof result?.content === "string" ? result.content : "";

  return (
    <div
      data-testid="bash-tool-widget"
      className="my-1.5 rounded-lg border border-border bg-muted/50 text-sm dark:bg-[#1e1e2e]"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2"
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon result={result} />
        <TerminalIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-green-400" />
        <code className="min-w-0 truncate text-emerald-700 text-xs dark:text-green-300">
          {title.label} {title.detail}
        </code>
        {result &&
          (expanded ? (
            <ChevronDownIcon className="ml-auto size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="ml-auto size-3.5 text-muted-foreground" />
          ))}
      </button>
      {expanded && resultContent && (
        <div className="app-scrollbar max-h-40 overflow-auto border-border border-t px-3 py-2 dark:border-border/50">
          <pre className="whitespace-pre-wrap font-mono text-slate-700 text-xs dark:text-gray-300">
            {truncate(resultContent, 2000)}
          </pre>
        </div>
      )}
    </div>
  );
};

// ─── Glob Widget ───

const GlobWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
      <StatusIcon result={result} />
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground">
        {toolTitle({ type: "tool_use", name: "glob", input }, result).label}{" "}
        <code className="rounded bg-muted px-1 text-xs">{input?.pattern}</code>
      </span>
    </div>
  );
};

// ─── Grep Widget ───

const GrepWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
      <StatusIcon result={result} />
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground">
        {toolTitle({ type: "tool_use", name: "grep", input }, result).label}{" "}
        <code className="rounded bg-muted px-1 text-xs">{input?.pattern}</code>
      </span>
    </div>
  );
};

// ─── AskUserQuestion Widget ───

export const AskUserQuestionWidget: FC<{
  input: any;
  result?: ContentBlock;
  onAnswer?: (answer: string) => Promise<void>;
  allowSkip?: boolean;
}> = ({ input, result, onAnswer, allowSkip = true }) => {
  const questions: any[] = input?.questions || [];
  const [answered, setAnswered] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customAnswer, setCustomAnswer] = useState("");
  const widgetRef = useRef<HTMLDivElement>(null);
  const lastFocusedChoiceRef = useRef<HTMLButtonElement | null>(null);
  const interactive = Boolean(onAnswer);

  // In -p mode, AskUserQuestion always errors because CLI can't prompt interactively.
  // The process is killed when AskUserQuestion is detected, so result may be undefined.
  // Options are clickable when there's no result or an error result.
  const isStreaming = useAgentChatStore((s) => s.isStreaming);
  const needsUserAnswer =
    !answered &&
    !submitting &&
    (onAnswer ? true : !isStreaming && (!result || result.is_error));

  useEffect(() => {
    if (!interactive || !needsUserAnswer) return;
    const deadline = performance.now() + 1000;
    let frame: number;
    const focusWhenVisible = () => {
      if (widgetRef.current?.contains(document.activeElement)) return;
      const first = widgetRef.current?.querySelector<HTMLButtonElement>(
        "[data-question-option]",
      );
      // Hidden workspace composers and transcript copies must not steal focus.
      if (
        first?.checkVisibility?.({
          checkOpacity: true,
          checkVisibilityCSS: true,
        })
      ) {
        first.focus({ preventScroll: true });
      } else if (performance.now() < deadline) {
        // Allow the panel's entrance transition to reveal the active composer.
        frame = requestAnimationFrame(focusWhenVisible);
      }
    };
    frame = requestAnimationFrame(focusWhenVisible);
    return () => cancelAnimationFrame(frame);
  }, [interactive, needsUserAnswer]);

  const handleOptionClick = async (_question: string, label: string) => {
    if (onAnswer) {
      if (!needsUserAnswer || !label.trim()) return;
      setSubmitting(true);
      setError(null);
      try {
        await onAnswer(label);
        setAnswered(true);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    const { sendPrompt, isStreaming } = useAgentChatStore.getState();
    if (isStreaming) return;
    setAnswered(true);
    sendPrompt(`${label}`);
  };

  if (questions.length === 0) {
    return (
      <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
        <StatusIcon result={result} />
        <MessageCircleQuestionIcon className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          {result ? "Asked question" : "Asking question..."}
        </span>
      </div>
    );
  }

  // Match the former plan-input panel: question first, compact neutral rows.
  const headerLabel = submitting
    ? "Sending answer…"
    : isStreaming && !onAnswer
      ? "Waiting for answer..."
      : needsUserAnswer
        ? "Choose an option"
        : answered
          ? "Answer sent"
          : "Question answered";

  return (
    <div
      ref={widgetRef}
      className="flex max-h-[min(20rem,45dvh)] min-h-0 w-full flex-col overflow-hidden px-4 pt-2 pb-3 text-sm"
      data-testid="agent-question-widget"
    >
      <div className="flex min-h-0 flex-col gap-3">
        {questions.map((q: any, qIdx: number) => (
          <div key={qIdx} className="flex min-h-0 flex-col">
            {q.header && (
              <p className="mb-1 shrink-0 text-muted-foreground text-xs">
                {q.header}
              </p>
            )}
            <div className="-mr-2 mb-2 flex shrink-0 items-start gap-3">
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1 pt-1">
                <p className="min-w-0 flex-auto break-words font-semibold text-foreground text-sm leading-snug">
                  {q.question}
                </p>
                {needsUserAnswer && (
                  <span className="shrink-0 text-left text-muted-foreground text-xs">
                    ↑ ↓ to navigate
                  </span>
                )}
              </div>
              {needsUserAnswer &&
                onAnswer &&
                allowSkip &&
                !q.permission &&
                qIdx === 0 && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() =>
                      void handleOptionClick(
                        "",
                        "Skip this question (no option selected).",
                      )
                    }
                    className="h-7 px-2 text-xs leading-none"
                  >
                    Skip
                  </Button>
                )}
            </div>
            <div
              data-testid="agent-question-options"
              className="app-scrollbar -mx-4 -mt-1 min-h-0 space-y-1 overflow-y-auto overscroll-contain px-2 pt-1 pb-3"
              style={{
                maskImage:
                  "linear-gradient(to bottom, transparent, black 4px, black calc(100% - 6px), transparent)",
                WebkitMaskImage:
                  "linear-gradient(to bottom, transparent, black 4px, black calc(100% - 6px), transparent)",
              }}
            >
              {q.details && (
                <details className="mx-2 mb-2 rounded-md border p-2 text-xs">
                  <summary className="cursor-pointer">Action details</summary>
                  <pre className="app-scrollbar mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                    {q.details}
                  </pre>
                </details>
              )}
              {q.options?.map((opt: any, oIdx: number) => (
                <div
                  key={oIdx}
                  onMouseEnter={(event) => {
                    if (!needsUserAnswer) return;
                    event.currentTarget
                      .querySelector<HTMLButtonElement>(
                        "[data-question-option]",
                      )
                      ?.focus({ preventScroll: true });
                  }}
                  className={`flex items-center rounded-lg px-2 outline-1 outline-transparent -outline-offset-1 transition-colors ${
                    needsUserAnswer
                      ? "text-muted-foreground has-[[data-question-option]:focus]:bg-background has-[[data-question-option]:focus]:text-foreground has-[[data-question-option]:focus]:outline-border dark:has-[[data-question-option]:focus]:bg-muted dark:has-[[data-question-option]:focus]:outline-white/25"
                      : "text-muted-foreground opacity-70"
                  }`}
                >
                  <button
                    type="button"
                    data-question-option="true"
                    onFocus={(event) => {
                      lastFocusedChoiceRef.current = event.currentTarget;
                    }}
                    disabled={!needsUserAnswer}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                        return;
                      event.preventDefault();
                      event.stopPropagation();
                      const options = Array.from(
                        widgetRef.current?.querySelectorAll<HTMLButtonElement>(
                          "[data-question-option]:not(:disabled)",
                        ) ?? [],
                      );
                      const index = options.indexOf(event.currentTarget);
                      const next =
                        options[
                          (index +
                            (event.key === "ArrowDown" ? 1 : -1) +
                            options.length) %
                            options.length
                        ];
                      next?.focus({ preventScroll: true });
                      next?.scrollIntoView({ block: "nearest" });
                    }}
                    onClick={() =>
                      needsUserAnswer &&
                      void handleOptionClick(q.question, opt.label)
                    }
                    className="group/choice flex min-h-9 min-w-0 flex-1 items-start rounded-lg px-0 py-2 text-left text-sm leading-5 outline-none disabled:cursor-default"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-0.5 mr-1 inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-muted-foreground text-[10px] text-background leading-none group-focus/choice:bg-foreground"
                    >
                      {oIdx + 1}
                    </span>
                    <span className="min-w-0 break-words">{opt.label}</span>
                  </button>
                  {opt.description && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={`About ${opt.label}`}
                          className="inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-muted-foreground/50 text-[10px] text-muted-foreground leading-none outline-none hover:border-foreground/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          ?
                        </button>
                      </TooltipTrigger>
                      <TooltipContent
                        side="top"
                        sideOffset={6}
                        className="max-w-56 text-xs"
                      >
                        {opt.description}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {onAnswer && !answered && !questions.some((q) => q.permission) && (
        <form
          className="group relative -mx-4 -mb-3 flex shrink-0 items-center gap-2 px-4 py-2 before:pointer-events-none before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-input"
          onBlur={(event) => {
            // Preserve deliberate moves to Send, another choice, or other controls.
            if (event.relatedTarget && event.relatedTarget !== document.body)
              return;
            queueMicrotask(() => {
              const choice = lastFocusedChoiceRef.current;
              if (
                document.activeElement === document.body &&
                choice?.isConnected &&
                !choice.disabled
              ) {
                choice.focus({ preventScroll: true });
              }
            });
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void handleOptionClick("", customAnswer);
          }}
        >
          <label className="flex min-h-9 min-w-0 flex-1 items-center text-muted-foreground text-sm">
            <input
              aria-label="Custom answer"
              placeholder="Or type your own answer"
              maxLength={4000}
              value={customAnswer}
              onChange={(event) => setCustomAnswer(event.target.value)}
              disabled={submitting}
              className="min-w-0 flex-1 bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground"
            />
          </label>
          <span className="invisible -mr-1.5 inline-flex shrink-0 opacity-0 transition-[opacity,visibility] duration-160 ease-out group-focus-within:visible group-focus-within:opacity-100 motion-reduce:transition-none">
            <button
              type="submit"
              aria-label="Send custom answer"
              disabled={!needsUserAnswer || !customAnswer.trim()}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:opacity-50"
            >
              <ArrowUpIcon aria-hidden="true" className="size-3.5" />
            </button>
          </span>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-2 shrink-0 text-destructive text-xs">
          {error}
        </p>
      )}
      {!needsUserAnswer && (
        <p
          role="status"
          className="mt-2 shrink-0 text-muted-foreground text-xs"
        >
          {headerLabel}
        </p>
      )}
    </div>
  );
};

// ─── TodoWrite Widget ───

const TodoWriteWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  const [expanded, setExpanded] = useExpanded(true);
  const todos: any[] = Array.isArray(input?.todos) ? input.todos : [];

  const statusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckIcon className="size-3.5 text-green-500" />;
      case "in_progress":
        return <ClockIcon className="size-3.5 animate-pulse text-blue-500" />;
      default:
        return <CircleIcon className="size-3.5 text-muted-foreground/40" />;
    }
  };

  const title = toolTitle(
    { type: "tool_use", name: "todowrite", input },
    result,
  );

  return (
    <div className="my-1.5 rounded-lg border border-border bg-muted/50 text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2"
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon result={result} />
        <ListTodoIcon className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">{title.label}</span>
        {expanded ? (
          <ChevronDownIcon className="ml-auto size-3.5 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="ml-auto size-3.5 text-muted-foreground" />
        )}
      </button>
      {expanded && todos.length > 0 && (
        <div className="space-y-0.5 border-border border-t px-3 py-2">
          {todos.map((todo, idx) => (
            <div
              key={idx}
              className={`flex items-center gap-2 rounded px-1.5 py-1 ${
                todo.status === "completed" ? "opacity-50" : ""
              }`}
            >
              {statusIcon(todo.status)}
              <span
                className={`text-xs ${
                  todo.status === "completed"
                    ? "text-muted-foreground line-through"
                    : todo.status === "in_progress"
                      ? "font-medium text-foreground"
                      : "text-muted-foreground"
                }`}
              >
                {todo.status === "in_progress"
                  ? todo.activeForm || todo.content
                  : todo.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Generic Widget ───

const GenericWidget: FC<{
  name: string;
  input: any;
  result?: ContentBlock;
}> = ({ name, input, result }) => {
  const [expanded, setExpanded] = useExpanded(false);

  return (
    <div className="my-1.5 rounded-lg border border-border bg-muted/50 text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2"
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon result={result} />
        <WrenchIcon className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          {toolTitle({ type: "tool_use", name, input }, result).label}{" "}
          <code className="text-xs">{name}</code>
        </span>
        {expanded ? (
          <ChevronDownIcon className="ml-auto size-3.5 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="ml-auto size-3.5 text-muted-foreground" />
        )}
      </button>
      {expanded && input && (
        <div className="app-scrollbar max-h-32 overflow-auto border-border border-t px-3 py-2">
          <pre className="whitespace-pre-wrap font-mono text-muted-foreground text-xs">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
};

// ─── Thinking Widget ───

export const ThinkingWidget: FC<{
  thinking: string;
  signature?: string;
  stateKey?: string;
}> = ({ thinking, stateKey }) => {
  const [expanded, setExpanded] = useExpanded(false, stateKey);
  const trimmed = thinking.trim();

  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-muted-foreground/20 bg-muted-foreground/5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-2 transition-colors hover:bg-muted-foreground/10"
      >
        <div className="flex items-center gap-2">
          <div className="relative">
            <BotMessageSquareIcon className="size-4 text-muted-foreground" />
            <SparklesIcon className="absolute -top-1 -right-1 size-2.5 animate-pulse text-muted-foreground/70" />
          </div>
          <span className="font-medium text-muted-foreground text-sm italic">
            Thinking...
          </span>
        </div>
        <ChevronRightIcon
          className={`size-4 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
        />
      </button>
      {expanded && (
        <div className="border-muted-foreground/20 border-t px-3 pt-2 pb-3">
          <pre className="whitespace-pre-wrap rounded-lg bg-muted-foreground/5 p-3 font-mono text-muted-foreground text-xs italic">
            {trimmed}
          </pre>
        </div>
      )}
    </div>
  );
};

// ─── Helpers ───

function truncate(str: string, max: number): string {
  if (!str) return "";
  return str.length > max ? `${str.slice(0, max)}...` : str;
}
