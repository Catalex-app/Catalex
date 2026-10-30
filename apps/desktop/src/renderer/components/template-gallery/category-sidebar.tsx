import {
  FileTextIcon,
  GraduationCapIcon,
  BriefcaseIcon,
  PaletteIcon,
  SparklesIcon,
  MonitorIcon,
  LayoutIcon,
  UserIcon,
  MailIcon,
  ClipboardListIcon,
  BookIcon,
  NewspaperIcon,
  FileIcon,
} from "lucide-react";
import {
  type TemplateCategory,
  type TemplateSubcategory,
  CATEGORY_LABELS,
  getCategories,
  getAllTemplates,
  getTemplatesByCategory,
} from "@/lib/template-registry";
import { useTemplateStore } from "@/stores/template-store";

const CATEGORY_ICONS: Record<TemplateCategory, React.ReactNode> = {
  academic: <GraduationCapIcon className="size-4" />,
  professional: <BriefcaseIcon className="size-4" />,
  creative: <PaletteIcon className="size-4" />,
  starter: <SparklesIcon className="size-4" />,
};

const _SUBCATEGORY_ICONS: Record<TemplateSubcategory, React.ReactNode> = {
  papers: <FileTextIcon className="size-3.5" />,
  theses: <GraduationCapIcon className="size-3.5" />,
  presentations: <MonitorIcon className="size-3.5" />,
  posters: <LayoutIcon className="size-3.5" />,
  cv: <UserIcon className="size-3.5" />,
  letters: <MailIcon className="size-3.5" />,
  reports: <ClipboardListIcon className="size-3.5" />,
  books: <BookIcon className="size-3.5" />,
  newsletters: <NewspaperIcon className="size-3.5" />,
  blank: <FileIcon className="size-3.5" />,
};

export function CategorySidebar() {
  const selectedCategory = useTemplateStore((s) => s.selectedCategory);
  const setSelectedCategory = useTemplateStore((s) => s.setSelectedCategory);
  const allCount = getAllTemplates().length;

  return (
    <nav
      aria-label="Template categories"
      className="app-scrollbar flex min-h-0 w-full flex-col gap-1 overflow-y-auto px-3 py-2"
    >
      {/* All templates */}
      <button
        type="button"
        onClick={() => setSelectedCategory(null)}
        aria-current={selectedCategory === null ? "page" : undefined}
        className={`flex h-9 items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors ${
          selectedCategory === null
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-foreground hover:bg-sidebar-accent/60"
        }`}
      >
        <SparklesIcon className="size-4" />
        <span className="flex-1">All Templates</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {allCount}
        </span>
      </button>

      <div className="my-1.5 h-px bg-sidebar-border" />

      {/* Categories */}
      {getCategories().map((cat) => {
        const count = getTemplatesByCategory(cat).length;
        const isActive = selectedCategory === cat;
        return (
          <button
            type="button"
            key={cat}
            onClick={() => setSelectedCategory(isActive ? null : cat)}
            aria-current={isActive ? "page" : undefined}
            className={`flex h-9 items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors ${
              isActive
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-foreground hover:bg-sidebar-accent/60"
            }`}
          >
            {CATEGORY_ICONS[cat]}
            <span className="flex-1">{CATEGORY_LABELS[cat]}</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {count}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
