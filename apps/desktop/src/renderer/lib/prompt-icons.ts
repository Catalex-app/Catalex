import { createElement, lazy, Suspense, type ComponentType } from "react";
import {
  BookOpenIcon,
  CalculatorIcon,
  CodeIcon,
  FileTextIcon,
  LanguagesIcon,
  LightbulbIcon,
  ListChecksIcon,
  ListTreeIcon,
  MessageCircleIcon,
  BookmarkIcon,
  PencilIcon,
  QuoteIcon,
  SearchIcon,
  SparklesIcon,
  SpellCheckIcon,
  TargetIcon,
  WandSparklesIcon,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import {
  type PromptIconName,
  type LibraryPrompt,
  type PROMPT_ICON_NAMES,
  resolvePromptIcon,
} from "./prompt-library";

const PROMPT_ICONS: Record<
  (typeof PROMPT_ICON_NAMES)[number],
  { label: string; icon: LucideIcon }
> = {
  "spell-check": { label: "Spell check", icon: SpellCheckIcon },
  pencil: { label: "Pencil", icon: PencilIcon },
  lightbulb: { label: "Lightbulb", icon: LightbulbIcon },
  "list-tree": { label: "Outline", icon: ListTreeIcon },
  search: { label: "Search", icon: SearchIcon },
  languages: { label: "Languages", icon: LanguagesIcon },
  "file-text": { label: "Document", icon: FileTextIcon },
  "list-checks": { label: "Checklist", icon: ListChecksIcon },
  "book-open": { label: "Book", icon: BookOpenIcon },
  quote: { label: "Quote", icon: QuoteIcon },
  code: { label: "Code", icon: CodeIcon },
  calculator: { label: "Calculator", icon: CalculatorIcon },
  sparkles: { label: "Sparkles", icon: SparklesIcon },
  "message-circle": { label: "Chat", icon: MessageCircleIcon },
  target: { label: "Target", icon: TargetIcon },
  "wand-sparkles": { label: "Magic wand", icon: WandSparklesIcon },
};

function suggestedIcon(name: PromptIconName) {
  return Object.prototype.hasOwnProperty.call(PROMPT_ICONS, name)
    ? PROMPT_ICONS[name as keyof typeof PROMPT_ICONS]
    : undefined;
}

export function promptIconLabel(name: PromptIconName): string {
  const label = name.replace(/-/g, " ");
  return (
    suggestedIcon(name)?.label ?? label.charAt(0).toUpperCase() + label.slice(1)
  );
}

function loadCatalog() {
  return import("lucide-react/dynamicIconImports").then(
    (module) => module.default,
  );
}

export async function loadPromptIconNames(): Promise<PromptIconName[]> {
  return Object.keys(await loadCatalog()).sort() as PromptIconName[];
}

const customIcons = new Map<PromptIconName, ComponentType<LucideProps>>();

export function promptIcon(name: PromptIconName): ComponentType<LucideProps> {
  if (name === "bookmark") return BookmarkIcon;
  const suggested = suggestedIcon(name);
  if (suggested) return suggested.icon;
  const cached = customIcons.get(name);
  if (cached) return cached;

  const Icon = lazy<ComponentType<LucideProps>>(async () => {
    try {
      const catalog = await loadCatalog();
      if (Object.prototype.hasOwnProperty.call(catalog, name)) {
        return await catalog[name]();
      }
    } catch {
      // A missing icon should never prevent a prompt from rendering.
    }
    return { default: () => null };
  });
  const CustomIcon = (props: LucideProps) =>
    createElement(Suspense, { fallback: null }, createElement(Icon, props));
  customIcons.set(name, CustomIcon);
  return CustomIcon;
}

export function libraryPromptIcon(prompt: LibraryPrompt) {
  const name = resolvePromptIcon(prompt);
  return name ? promptIcon(name) : undefined;
}
