import {
  WorkspacePanelHeader,
  useWorkspacePanelExpansion,
} from "../workspace-panel";
import { usePreviewSearch, PreviewSearchPanel } from "./preview-search-panel";
import { useMarkdownSearch } from "./markdown-search";
import { installContextMenus } from "@/lib/context-menu";
import { installMouseBoundary } from "@/lib/mouse-events";
import { Hint } from "@/components/ui/tooltip";
import { MarkdownComments } from "./markdown-comments";
import { MarkdownThemeSwatch } from "./markdown-theme-swatch";
import {
  GITHUB_LIGHT_MARKDOWN_THEME_COLORS,
  GITHUB_DARK_MARKDOWN_THEME_COLORS,
} from "@/lib/markdown-theme-colors";
import { markdownCommentSource } from "./markdown-comment-source";
import {
  cancelNavigationScroll,
  isNavigationScrolling,
  scrollForNavigation,
} from "@/lib/navigation-scroll";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { markdownCodeHighlighting } from "@/lib/markdown-code-highlighting";
import { invoke } from "@/lib/desktop/core";
import { isDesktop } from "@/lib/desktop/bridge";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import {
  markdownAnchorId,
  markdownFormatting,
  markdownFragment,
  markdownHtmlSchema,
  markdownLinkPosition,
} from "@/lib/markdown-rendering";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  LoaderIcon,
  MoonIcon,
  PaletteIcon,
  SunIcon,
  XIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { save } from "@/lib/desktop/dialog";
import { writeFile } from "@/lib/desktop/fs";
import { toast } from "sonner";
import katexThemeCss from "katex/dist/katex.min.css?inline";
import markdownPreviewThemeCss from "./markdown-preview-theme.css?inline";
import {
  isMarkdownFile,
  resolveMarkdownProjectFile,
  rewriteMarkdownCssAssetUrls,
} from "@/lib/markdown";
import {
  externalMarkdownThemeId,
  GITHUB_DARK_MARKDOWN_THEME_ID,
  GITHUB_LIGHT_MARKDOWN_THEME_ID,
  type InstalledMarkdownTheme,
  isBuiltInMarkdownTheme,
  listMarkdownThemes,
  pathFromExternalMarkdownThemeId,
  readMarkdownTheme,
  resolveMarkdownThemeDirectory,
  rewriteExternalMarkdownThemeAssetUrls,
} from "@/lib/markdown-theme";
import { getAssetUrl } from "@/lib/project-files";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { broadcastSettingsChanged } from "@/components/settings/solar-mode-effect";
import { Button } from "@/components/ui/button";
import { DialogResizeTransition } from "@/components/ui/dialog-resize-transition";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const PROJECT_MARKDOWN_THEME_PREFIX = "__catalex_project_theme__:";
const FRAME_SOURCE =
  '<!doctype html><html><head><meta charset="utf-8"></head><body><main id="write"></main></body></html>';
const SOURCE_ELEMENT_SELECTOR = "[data-markdown-source-start]";
const PDF_MARGIN_POINTS = 36;
const MAX_PDF_CANVAS_PIXELS = 32_000_000;
const MAX_PDF_CANVAS_SIDE = 32_000;
const NATIVE_PDF_ROOT_ATTRIBUTE = "data-catalex-markdown-pdf-root";
const NATIVE_PDF_THEME_STYLE_ID = "catalex-markdown-pdf-theme";
const NATIVE_PDF_LAYOUT_STYLE_ID = "catalex-markdown-pdf-layout";

function projectMarkdownThemeId(fileId: string) {
  return `${PROJECT_MARKDOWN_THEME_PREFIX}${fileId}`;
}

function markdownThemeIdForSelection(selection: string) {
  return isBuiltInMarkdownTheme(selection)
    ? selection
    : externalMarkdownThemeId(selection);
}

async function exportMarkdownPdfNative(
  frameDocument: Document,
  fileName: string,
  filePath: string,
) {
  if (!isDesktop()) return false;

  const writeElement = frameDocument.getElementById("write");
  if (!writeElement?.textContent?.trim()) {
    throw new Error("The Markdown preview is empty.");
  }
  const previewThemeStyle = frameDocument.getElementById(
    "catalex-markdown-preview-style",
  );
  if (!previewThemeStyle || previewThemeStyle.tagName !== "STYLE") {
    throw new Error("The Markdown preview theme is not ready yet.");
  }

  const printRoot = writeElement.cloneNode(true) as HTMLElement;
  printRoot.setAttribute(NATIVE_PDF_ROOT_ATTRIBUTE, "");
  printRoot.style.display = "none";

  const themeStyle = document.createElement("style");
  themeStyle.id = NATIVE_PDF_THEME_STYLE_ID;
  themeStyle.media = "print";
  themeStyle.textContent = previewThemeStyle.textContent;

  const layoutStyle = document.createElement("style");
  layoutStyle.id = NATIVE_PDF_LAYOUT_STYLE_ID;
  layoutStyle.media = "print";
  layoutStyle.textContent = `
    @page { size: A4 portrait; margin: 14mm; }
    html, body {
      height: auto !important;
      min-height: 0 !important;
      overflow: visible !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body { margin: 0 !important; }
    body > * { display: none !important; }
    body > #write[${NATIVE_PDF_ROOT_ATTRIBUTE}] {
      box-sizing: border-box !important;
      display: block !important;
      margin: 0 !important;
      max-width: none !important;
      min-height: 0 !important;
      padding: 0 !important;
      width: 100% !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body[data-preview-theme="github"] > #write[${NATIVE_PDF_ROOT_ATTRIBUTE}] {
      background-color: inherit !important;
      color: inherit !important;
    }
    #write pre,
    #write blockquote,
    #write table,
    #write img { break-inside: avoid; }
  `;

  const bodyAttributes = ["data-preview-theme", "data-color-scheme"] as const;
  const previousBodyAttributes = new Map(
    bodyAttributes.map((attribute) => [
      attribute,
      document.body.getAttribute(attribute),
    ]),
  );
  const previousHtmlColorScheme =
    document.documentElement.getAttribute("data-color-scheme");
  const previousTitle = document.title;

  for (const attribute of bodyAttributes) {
    const value = frameDocument.body.getAttribute(attribute);
    if (value === null) document.body.removeAttribute(attribute);
    else document.body.setAttribute(attribute, value);
  }
  const frameHtmlColorScheme =
    frameDocument.documentElement.getAttribute("data-color-scheme");
  if (frameHtmlColorScheme === null) {
    document.documentElement.removeAttribute("data-color-scheme");
  } else {
    document.documentElement.setAttribute(
      "data-color-scheme",
      frameHtmlColorScheme,
    );
  }
  document.title =
    fileName.replace(/\.(?:md|markdown|mdown|mkd|mkdn)$/i, "") || "Markdown";
  document.head.append(themeStyle, layoutStyle);
  document.body.append(printRoot);

  try {
    await Promise.all([
      document.fonts.ready,
      ...Array.from(printRoot.querySelectorAll("img"), (image) =>
        image.decode().catch(() => undefined),
      ),
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
    ]);
    return await invoke<boolean>("export_markdown_pdf_native", { filePath });
  } finally {
    printRoot.remove();
    themeStyle.remove();
    layoutStyle.remove();
    document.title = previousTitle;
    for (const attribute of bodyAttributes) {
      const value = previousBodyAttributes.get(attribute);
      if (value === null || value === undefined) {
        document.body.removeAttribute(attribute);
      } else {
        document.body.setAttribute(attribute, value);
      }
    }
    if (previousHtmlColorScheme === null) {
      document.documentElement.removeAttribute("data-color-scheme");
    } else {
      document.documentElement.setAttribute(
        "data-color-scheme",
        previousHtmlColorScheme,
      );
    }
  }
}

async function createMarkdownPdf(frameDocument: Document) {
  const frameWindow = frameDocument.defaultView;
  const writeElement = frameDocument.getElementById("write");
  if (!frameWindow || !writeElement) {
    throw new Error("The Markdown preview is not ready yet.");
  }

  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import("html2canvas"),
    import("jspdf"),
  ]);
  const sourceWidth = Math.max(
    writeElement.clientWidth,
    writeElement.scrollWidth,
  );
  const sourceHeight = Math.max(
    writeElement.clientHeight,
    writeElement.scrollHeight,
  );
  if (sourceWidth === 0 || sourceHeight === 0) {
    throw new Error("The Markdown preview is empty.");
  }

  const preferredScale = Math.min(2, Math.max(1, frameWindow.devicePixelRatio));
  const scale = Math.min(
    preferredScale,
    MAX_PDF_CANVAS_SIDE / sourceWidth,
    MAX_PDF_CANVAS_SIDE / sourceHeight,
    Math.sqrt(MAX_PDF_CANVAS_PIXELS / (sourceWidth * sourceHeight)),
  );
  const backgroundColor =
    frameWindow.getComputedStyle(frameDocument.body).backgroundColor ||
    "#ffffff";
  const canvas = await html2canvas(writeElement, {
    backgroundColor,
    height: sourceHeight,
    logging: false,
    scale,
    useCORS: true,
    width: sourceWidth,
    windowHeight: sourceHeight,
    windowWidth: sourceWidth,
  });

  const pdf = new jsPDF({
    compress: true,
    format: "a4",
    orientation: "portrait",
    unit: "pt",
  });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const contentWidth = pageWidth - PDF_MARGIN_POINTS * 2;
  const contentHeight = pageHeight - PDF_MARGIN_POINTS * 2;
  const slicePixelHeight = Math.max(
    1,
    Math.floor((canvas.width * contentHeight) / contentWidth),
  );

  const colorCanvas = frameDocument.createElement("canvas");
  colorCanvas.width = 1;
  colorCanvas.height = 1;
  const colorContext = colorCanvas.getContext("2d");
  if (colorContext) {
    colorContext.fillStyle = backgroundColor;
    colorContext.fillRect(0, 0, 1, 1);
  }
  const [red, green, blue] = colorContext
    ? colorContext.getImageData(0, 0, 1, 1).data
    : [255, 255, 255];

  for (
    let sourceY = 0, pageIndex = 0;
    sourceY < canvas.height;
    sourceY += slicePixelHeight, pageIndex += 1
  ) {
    if (pageIndex > 0) pdf.addPage();
    pdf.setFillColor(red, green, blue);
    pdf.rect(0, 0, pageWidth, pageHeight, "F");

    const currentSliceHeight = Math.min(
      slicePixelHeight,
      canvas.height - sourceY,
    );
    const slice = frameDocument.createElement("canvas");
    slice.width = canvas.width;
    slice.height = currentSliceHeight;
    const sliceContext = slice.getContext("2d");
    if (!sliceContext) throw new Error("Could not render the PDF page.");
    sliceContext.drawImage(
      canvas,
      0,
      sourceY,
      canvas.width,
      currentSliceHeight,
      0,
      0,
      canvas.width,
      currentSliceHeight,
    );
    const renderedSliceHeight =
      (currentSliceHeight * contentWidth) / canvas.width;
    pdf.addImage(
      slice.toDataURL("image/png"),
      "PNG",
      PDF_MARGIN_POINTS,
      PDF_MARGIN_POINTS,
      contentWidth,
      renderedSliceHeight,
      undefined,
      "FAST",
    );
  }

  const bytes = new Uint8Array(pdf.output("arraybuffer"));
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("PDF generation returned invalid data.");
  }
  return bytes;
}

type MarkdownSourcePoint = {
  line?: number;
  column?: number;
  offset?: number;
};

type MarkdownSourceNode = {
  position?: {
    start?: MarkdownSourcePoint;
    end?: MarkdownSourcePoint;
  };
};

type MarkdownSourceRange = {
  start: number;
  end: number;
};

function sourcePointOffset(
  point: MarkdownSourcePoint | undefined,
  lineStartOffsets: number[],
) {
  if (!point) return null;
  if (typeof point.offset === "number") return point.offset;
  if (typeof point.line !== "number") return null;
  const lineStart = lineStartOffsets[Math.max(0, point.line - 1)];
  if (lineStart === undefined) return null;
  return lineStart + Math.max(0, (point.column ?? 1) - 1);
}

function sourceRangeFromNode(
  node: unknown,
  lineStartOffsets: number[],
): MarkdownSourceRange | null {
  const sourceNode = node as MarkdownSourceNode | undefined;
  const start = sourcePointOffset(
    sourceNode?.position?.start,
    lineStartOffsets,
  );
  const end = sourcePointOffset(sourceNode?.position?.end, lineStartOffsets);
  if (start === null) return null;
  return { start, end: Math.max(start, end ?? start) };
}

function sourceRangeFromElement(element: HTMLElement) {
  const start = Number(element.dataset.markdownSourceStart);
  const end = Number(element.dataset.markdownSourceEnd);
  if (!Number.isFinite(start)) return null;
  return {
    start,
    end: Number.isFinite(end) ? Math.max(start, end) : start,
  };
}

function sourceElements(frameDocument: Document) {
  return Array.from(
    frameDocument.querySelectorAll<HTMLElement>(SOURCE_ELEMENT_SELECTOR),
  );
}

function sourceElementForPosition(frameDocument: Document, position: number) {
  let closest: { element: HTMLElement; distance: number } | null = null;
  let containing: { element: HTMLElement; span: number } | null = null;

  for (const element of sourceElements(frameDocument)) {
    const range = sourceRangeFromElement(element);
    if (!range) continue;
    if (position >= range.start && position <= range.end) {
      const span = range.end - range.start;
      if (!containing || span < containing.span) {
        containing = { element, span };
      }
      continue;
    }
    const distance = Math.min(
      Math.abs(position - range.start),
      Math.abs(position - range.end),
    );
    if (!closest || distance < closest.distance) {
      closest = { element, distance };
    }
  }

  return containing?.element ?? closest?.element ?? null;
}

function sourceElementAtPreviewCenter(frameDocument: Document) {
  const viewport = frameDocument.documentElement;
  const centerX = viewport.clientWidth / 2;
  const centerY = viewport.clientHeight / 2;
  const target = frameDocument.elementFromPoint(centerX, centerY);
  const targetSource = target?.closest<HTMLElement>(SOURCE_ELEMENT_SELECTOR);
  if (targetSource) return targetSource;

  let closest: { element: HTMLElement; distance: number } | null = null;
  for (const element of sourceElements(frameDocument)) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > viewport.clientHeight) continue;
    const distance = Math.abs(rect.top + rect.height / 2 - centerY);
    if (!closest || distance < closest.distance) {
      closest = { element, distance };
    }
  }
  return closest?.element ?? null;
}

function sourcePositionAtPreviewCenter(frameDocument: Document) {
  const element = sourceElementAtPreviewCenter(frameDocument);
  return element ? sourceRangeFromElement(element)?.start : undefined;
}

export function MarkdownPreview({
  editorVisible = false,
  layoutAnimating = false,
  syncNavigationRequest = null,
  onSyncNavigationHandled,
  scrollSyncEnabled = false,
  scrollSyncPaused = false,
  outlineTrackingEnabled = false,
  scrollSyncTarget = null,
  onScrollSyncToEditor,
}: {
  editorVisible?: boolean;
  layoutAnimating?: boolean;
  syncNavigationRequest?: {
    id: number;
    direction: "to-editor" | "to-preview";
  } | null;
  onSyncNavigationHandled?: (id: number) => void;
  scrollSyncEnabled?: boolean;
  scrollSyncPaused?: boolean;
  outlineTrackingEnabled?: boolean;
  scrollSyncTarget?: { id: number; position: number } | null;
  onScrollSyncToEditor?: (position: number) => void;
} = {}) {
  const searchScope = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const linkRequestRef = useRef(0);
  const [linkNavigation, setLinkNavigation] = useState<{
    fileId: string;
    position: number;
    fragment?: string;
    scroll?: { top: number; left: number };
  } | null>(null);
  const [linkReturn, setLinkReturn] = useState<{
    fileId: string;
    name: string;
    content: string | undefined;
    top: number;
    left: number;
    position: number;
    projectRoot: string | null;
    sessionId: string | null;
    selectionRevision: number;
  } | null>(null);
  const [commentToolbar, setCommentToolbar] = useState<HTMLDivElement | null>(
    null,
  );
  const [commentPanel, setCommentPanel] = useState<HTMLDivElement | null>(null);
  const lastHandledSyncNavigationIdRef = useRef<number | null>(null);
  const scrollSyncEnabledRef = useRef(scrollSyncEnabled);
  const onScrollSyncToEditorRef = useRef(onScrollSyncToEditor);
  const ignorePreviewScrollUntilRef = useRef(0);
  const lastPreviewScrollPositionRef = useRef<number | null>(null);
  const [frameDocument, setFrameDocument] = useState<Document | null>(null);
  const expansion = useWorkspacePanelExpansion();
  useEffect(() => {
    if (!frameDocument || !expansion?.expanded) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      expansion.onExpandedChange?.(false);
    };
    // Selection/comment handlers on the frame document get the first Escape.
    const frameWindow = frameDocument.defaultView;
    frameWindow?.addEventListener("keydown", keydown);
    return () => frameWindow?.removeEventListener("keydown", keydown);
  }, [frameDocument, expansion]);

  useEffect(() => {
    if (!frameDocument) return;
    const removeMouseBoundary = installMouseBoundary(frameDocument);
    const removeContextMenus = installContextMenus(frameDocument);
    return () => {
      removeContextMenus();
      removeMouseBoundary();
    };
  }, [frameDocument]);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [showAllTyporaThemes, setShowAllTyporaThemes] = useState(false);
  useEffect(() => {
    if (!themeMenuOpen || !frameDocument) return;
    // Pointer events inside the preview iframe do not reach Radix's outside listener.
    const dismiss = () => {
      setThemeMenuOpen(false);
      setShowAllTyporaThemes(false);
    };
    frameDocument.addEventListener("pointerdown", dismiss);
    return () => frameDocument.removeEventListener("pointerdown", dismiss);
  }, [themeMenuOpen, frameDocument]);
  const themeListRef = useRef<HTMLDivElement>(null);
  const allThemesButtonRef = useRef<HTMLDivElement>(null);
  const recentThemePaths = useSettingsStore(
    (state) => state.recentMarkdownThemeOrder,
  );
  const recordRecentTheme = useSettingsStore(
    (state) => state.recordRecentMarkdownTheme,
  );
  const activeFileId = useDocumentStore((state) => state.activeFileId);
  const projectRoot = useDocumentStore((state) => state.projectRoot);
  const mathEngine = useSettingsStore((state) =>
    state.getMarkdownMathEngineForFile(projectRoot, activeFileId),
  );
  const setFileMathEngine = useSettingsStore(
    (state) => state.setMarkdownMathEngineForFile,
  );
  const setMathEngine = useCallback(
    (engine: "katex" | "mathjax") => {
      if (projectRoot && activeFileId)
        setFileMathEngine(projectRoot, activeFileId, engine);
    },
    [projectRoot, activeFileId, setFileMathEngine],
  );
  const [mathjax, setMathjax] = useState<
    typeof import("@/lib/markdown-mathjax").default | null
  >(null);
  const loadingMath = mathEngine === "mathjax" && !mathjax;
  useEffect(() => {
    if (mathEngine !== "mathjax" || mathjax) return;
    let cancelled = false;
    import("@/lib/markdown-mathjax")
      .then(({ default: plugin }) => {
        if (!cancelled) setMathjax(() => plugin);
      })
      .catch(() => {
        if (cancelled) return;
        toast.error("Could not load MathJax");
        setMathEngine("katex");
        broadcastSettingsChanged();
      });
    return () => {
      cancelled = true;
    };
  }, [mathEngine, mathjax, setMathEngine]);
  const [commentToolbarVisible, setCommentToolbarVisible] = useState(false);
  const markdownLoadTyporaThemes = useSettingsStore(
    (state) => state.markdownLoadTyporaThemes,
  );
  const markdownThemeDirectory = useSettingsStore(
    (state) => state.markdownThemeDirectory,
  );
  const markdownSeparateLightDarkThemes = useSettingsStore(
    (state) => state.markdownSeparateLightDarkThemes,
  );
  const markdownPreviewTheme = useSettingsStore(
    (state) => state.markdownPreviewTheme,
  );
  const markdownPreviewLightTheme = useSettingsStore(
    (state) => state.markdownPreviewLightTheme,
  );
  const markdownPreviewDarkTheme = useSettingsStore(
    (state) => state.markdownPreviewDarkTheme,
  );
  const setMarkdownPreviewTheme = useSettingsStore(
    (state) => state.setMarkdownPreviewTheme,
  );
  const setMarkdownPreviewLightTheme = useSettingsStore(
    (state) => state.setMarkdownPreviewLightTheme,
  );
  const setMarkdownPreviewDarkTheme = useSettingsStore(
    (state) => state.setMarkdownPreviewDarkTheme,
  );
  const { resolvedTheme } = useTheme();
  const configuredTheme = markdownSeparateLightDarkThemes
    ? resolvedTheme === "dark"
      ? markdownPreviewDarkTheme
      : markdownPreviewLightTheme
    : markdownPreviewTheme;
  const effectiveConfiguredTheme =
    markdownLoadTyporaThemes || isBuiltInMarkdownTheme(configuredTheme)
      ? configuredTheme
      : resolvedTheme === "dark"
        ? GITHUB_DARK_MARKDOWN_THEME_ID
        : GITHUB_LIGHT_MARKDOWN_THEME_ID;
  const configuredThemeId = markdownThemeIdForSelection(
    effectiveConfiguredTheme,
  );
  const [selectedThemeId, setSelectedThemeId] = useState(configuredThemeId);
  const [installedMarkdownThemes, setInstalledMarkdownThemes] = useState<
    InstalledMarkdownTheme[]
  >([]);
  const [externalThemeCss, setExternalThemeCss] = useState("");
  const [previewThemeSurface, setPreviewThemeSurface] = useState<{
    background: string;
    color: string;
  } | null>(null);
  const files = useDocumentStore((state) => state.files);
  const sessionId = useDocumentStore((state) => state.agentWorkspaceSessionId);
  const selectionRevision = useDocumentStore(
    (state) => state.fileSelectionRevision,
  );
  useEffect(() => {
    if (
      linkReturn &&
      (linkReturn.projectRoot !== projectRoot ||
        linkReturn.sessionId !== sessionId ||
        linkReturn.selectionRevision !== selectionRevision ||
        !files.some(
          (file) =>
            file.id === linkReturn.fileId &&
            file.content === linkReturn.content,
        ))
    )
      setLinkReturn(null);
  }, [files, linkReturn, projectRoot, sessionId, selectionRevision]);
  const setActiveFile = useDocumentStore((state) => state.setActiveFile);
  const openFileInBackground = useDocumentStore(
    (state) => state.openFileInBackground,
  );
  const activeFile = files.find((file) => file.id === activeFileId);
  const markdownSource =
    activeFile && isMarkdownFile(activeFile) ? (activeFile.content ?? "") : "";
  const search = usePreviewSearch(searchScope, activeFileId, frameDocument);
  const markdownSearch = useMarkdownSearch(
    search,
    frameDocument,
    markdownSource,
  );
  const lineStartOffsets = useMemo(() => {
    const offsets = [0];
    for (let index = 0; index < markdownSource.length; index += 1) {
      if (markdownSource[index] === "\n") offsets.push(index + 1);
    }
    return offsets;
  }, [markdownSource]);
  const themeFiles = useMemo(
    () =>
      files
        .filter((file) => file.relativePath.toLowerCase().endsWith(".css"))
        .sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath),
        ),
    [files],
  );
  const selectedThemeFile = themeFiles.find(
    (file) => projectMarkdownThemeId(file.id) === selectedThemeId,
  );
  const selectedExternalThemePath =
    pathFromExternalMarkdownThemeId(selectedThemeId);
  const typoraThemes = useMemo(() => {
    const seen = new Set<string>();
    return [
      ...installedMarkdownThemes.map((theme) => ({
        id: externalMarkdownThemeId(theme.path),
        path: theme.path,
        label: theme.label,
        group: "Theme folder",
        css: undefined,
      })),
      ...themeFiles.map((file) => ({
        id: projectMarkdownThemeId(file.id),
        path: file.absolutePath,
        label: file.relativePath,
        group: "Project CSS",
        css: file.content ?? undefined,
      })),
    ].filter((theme) => {
      if (seen.has(theme.path)) return false;
      seen.add(theme.path);
      return true;
    });
  }, [installedMarkdownThemes, themeFiles]);
  const typoraThemeIds = typoraThemes.map((theme) => theme.id).join("\0");
  const recentThemes = recentThemePaths
    .flatMap((path) => {
      const theme = typoraThemes.find((theme) => theme.path === path);
      return theme ? [theme] : [];
    })
    .slice(0, 5);
  const selectedCustomThemePath =
    selectedThemeFile?.absolutePath ?? selectedExternalThemePath;
  useEffect(() => {
    if (!selectedCustomThemePath) return;
    recordRecentTheme(selectedCustomThemePath);
    broadcastSettingsChanged();
  }, [recordRecentTheme, selectedCustomThemePath]);
  useEffect(() => {
    if (!themeMenuOpen || !showAllTyporaThemes) return;
    const frame = requestAnimationFrame(() => {
      const list = themeListRef.current;
      if (!list) return;
      const selected = list.querySelector<HTMLElement>(
        '[role="menuitemradio"][data-state="checked"]',
      );
      const target =
        selected ?? list.querySelector<HTMLElement>('[role="menuitemradio"]');
      target?.focus({ preventScroll: true });
      if (selected) {
        list.scrollTop +=
          selected.getBoundingClientRect().top -
          list.getBoundingClientRect().top -
          (list.clientHeight - selected.offsetHeight) / 2;
      } else list.scrollTop = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [themeMenuOpen, showAllTyporaThemes, selectedThemeId, typoraThemeIds]);
  const showThemeMenuRoot = () => {
    setShowAllTyporaThemes(false);
    requestAnimationFrame(() =>
      allThemesButtonRef.current?.focus({ preventScroll: true }),
    );
  };
  const selectedThemeLabel =
    selectedThemeId === GITHUB_DARK_MARKDOWN_THEME_ID
      ? "GitHub Dark"
      : selectedThemeId === GITHUB_LIGHT_MARKDOWN_THEME_ID
        ? "GitHub Light"
        : (selectedThemeFile?.relativePath ??
          installedMarkdownThemes.find(
            (theme) => theme.path === selectedExternalThemePath,
          )?.label ??
          selectedExternalThemePath
            ?.split(/[\\/]/)
            .pop()
            ?.replace(/\.css$/i, "") ??
          "Custom theme");
  const customThemeCss = useMemo(
    () =>
      selectedThemeFile?.content
        ? rewriteMarkdownCssAssetUrls(
            selectedThemeFile.content,
            selectedThemeFile,
            files,
            getAssetUrl,
          )
        : externalThemeCss,
    [externalThemeCss, files, selectedThemeFile],
  );

  scrollSyncEnabledRef.current = scrollSyncEnabled && !scrollSyncPaused;
  onScrollSyncToEditorRef.current = onScrollSyncToEditor;

  useEffect(() => {
    setSelectedThemeId(configuredThemeId);
  }, [configuredThemeId]);

  useEffect(() => {
    let cancelled = false;
    setInstalledMarkdownThemes([]);
    if (!markdownLoadTyporaThemes) return;
    resolveMarkdownThemeDirectory(markdownThemeDirectory)
      .then(async (directory) => {
        if (!directory) return;
        const themes = await listMarkdownThemes(directory);
        if (!cancelled) setInstalledMarkdownThemes(themes);
      })
      .catch(() => {
        if (!cancelled) setInstalledMarkdownThemes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [markdownLoadTyporaThemes, markdownThemeDirectory]);

  useEffect(() => {
    let cancelled = false;
    if (!markdownLoadTyporaThemes || !selectedExternalThemePath) {
      setExternalThemeCss("");
      return;
    }
    readMarkdownTheme(selectedExternalThemePath)
      .then((css) => {
        if (cancelled) return;
        setExternalThemeCss(
          rewriteExternalMarkdownThemeAssetUrls(
            css,
            selectedExternalThemePath,
            getAssetUrl,
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setExternalThemeCss("");
      });
    return () => {
      cancelled = true;
    };
  }, [markdownLoadTyporaThemes, selectedExternalThemePath]);

  useEffect(() => {
    lastPreviewScrollPositionRef.current = null;
  }, [activeFileId]);

  useEffect(() => {
    if (
      selectedThemeId.startsWith(PROJECT_MARKDOWN_THEME_PREFIX) &&
      !themeFiles.some(
        (file) => projectMarkdownThemeId(file.id) === selectedThemeId,
      )
    ) {
      setSelectedThemeId(configuredThemeId);
    }
  }, [configuredThemeId, selectedThemeId, themeFiles]);

  useEffect(() => {
    if (!frameDocument) return;
    const previewColorScheme =
      selectedThemeId === GITHUB_DARK_MARKDOWN_THEME_ID
        ? "dark"
        : selectedThemeId === GITHUB_LIGHT_MARKDOWN_THEME_ID
          ? "light"
          : resolvedTheme === "dark"
            ? "dark"
            : "light";
    frameDocument.body.dataset.previewTheme = isBuiltInMarkdownTheme(
      selectedThemeId,
    )
      ? "github"
      : "typora";
    if (isBuiltInMarkdownTheme(selectedThemeId)) {
      frameDocument.body.dataset.colorScheme = previewColorScheme;
      frameDocument.documentElement.dataset.colorScheme = previewColorScheme;
    } else {
      delete frameDocument.body.dataset.colorScheme;
      delete frameDocument.documentElement.dataset.colorScheme;
    }

    let style = frameDocument.head.querySelector<HTMLStyleElement>(
      "#catalex-markdown-preview-style",
    );
    if (!style) {
      style = frameDocument.createElement("style");
      style.id = "catalex-markdown-preview-style";
      frameDocument.head.appendChild(style);
    }
    style.textContent = `${markdownPreviewThemeCss}\n${katexThemeCss}\n${customThemeCss}`;

    const frameId = requestAnimationFrame(() => {
      const frameWindow = frameDocument.defaultView;
      if (!frameWindow) return;
      const computedBodyStyle = frameWindow.getComputedStyle(
        frameDocument.body,
      );
      setPreviewThemeSurface({
        background: computedBodyStyle.backgroundColor,
        color: computedBodyStyle.color,
      });
    });
    return () => cancelAnimationFrame(frameId);
  }, [
    customThemeCss,
    frameDocument,
    resolvedTheme,
    selectedExternalThemePath,
    selectedThemeId,
    selectedThemeFile,
  ]);

  const previewPanelStyle = useMemo(() => {
    if (!previewThemeSurface) return undefined;
    const { background, color } = previewThemeSurface;
    return {
      "--background": background,
      "--foreground": color,
      "--muted-foreground": `color-mix(in srgb, ${color} 68%, transparent)`,
      "--secondary": `color-mix(in srgb, ${color} 10%, ${background})`,
      "--secondary-foreground": color,
      "--border": `color-mix(in srgb, ${color} 18%, ${background})`,
      "--input": `color-mix(in srgb, ${color} 18%, ${background})`,
      "--ring": `color-mix(in srgb, ${color} 45%, ${background})`,
      backgroundColor: background,
      color,
      colorScheme:
        selectedThemeId === GITHUB_DARK_MARKDOWN_THEME_ID
          ? "dark"
          : selectedThemeId === GITHUB_LIGHT_MARKDOWN_THEME_ID
            ? "light"
            : undefined,
    } as CSSProperties;
  }, [previewThemeSurface, selectedThemeId]);
  const ThemeModeIcon = markdownSeparateLightDarkThemes
    ? resolvedTheme === "dark"
      ? MoonIcon
      : SunIcon
    : PaletteIcon;
  const themeModeIcon = markdownSeparateLightDarkThemes
    ? resolvedTheme === "dark"
      ? "dark"
      : "light"
    : "shared";

  const handleThemeChange = useCallback(
    (value: string) => {
      setSelectedThemeId(value);
      const externalPath = pathFromExternalMarkdownThemeId(value);
      const persistentTheme = isBuiltInMarkdownTheme(value)
        ? value
        : externalPath;
      if (!persistentTheme) return;
      if (!markdownSeparateLightDarkThemes) {
        setMarkdownPreviewTheme(persistentTheme);
      } else if (resolvedTheme === "dark") {
        setMarkdownPreviewDarkTheme(persistentTheme);
      } else {
        setMarkdownPreviewLightTheme(persistentTheme);
      }
      broadcastSettingsChanged();
    },
    [
      markdownSeparateLightDarkThemes,
      resolvedTheme,
      setMarkdownPreviewDarkTheme,
      setMarkdownPreviewLightTheme,
      setMarkdownPreviewTheme,
    ],
  );

  const handleExportPdf = useCallback(async () => {
    if (!frameDocument || !activeFile || isExportingPdf) return;
    setIsExportingPdf(true);
    try {
      const defaultName = activeFile.name.replace(
        /\.(?:md|markdown|mdown|mkd|mkdn)$/i,
        ".pdf",
      );
      const filePath = await save({
        title: "Export Markdown as PDF",
        defaultPath: defaultName,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!filePath) return;

      const exportedNatively = await exportMarkdownPdfNative(
        frameDocument,
        activeFile.name,
        filePath,
      );
      if (!exportedNatively) {
        const pdfBytes = await createMarkdownPdf(frameDocument);
        await writeFile(filePath, pdfBytes);
      }
      toast.success("Markdown exported as PDF");
    } catch (error) {
      toast.error("Could not export Markdown as PDF", {
        description:
          error instanceof Error ? error.message : "An unknown error occurred.",
      });
    } finally {
      setIsExportingPdf(false);
    }
  }, [activeFile, frameDocument, isExportingPdf]);

  const navigateEditorToPreview = useCallback(() => {
    if (!frameDocument) return;
    const state = useDocumentStore.getState();
    const position = state.selectionRange?.start ?? state.cursorPosition;
    const element = sourceElementForPosition(frameDocument, position);
    const scroll = frameDocument.scrollingElement as HTMLElement | null;
    if (element && scroll) {
      const rect = element.getBoundingClientRect();
      scrollForNavigation(scroll, {
        top:
          scroll.scrollTop +
          rect.top +
          rect.height / 2 -
          frameDocument.documentElement.clientHeight / 2,
      });
    }
  }, [frameDocument]);

  useEffect(
    () => () => {
      const scroll = frameDocument?.scrollingElement;
      if (scroll) cancelNavigationScroll(scroll as HTMLElement);
    },
    [frameDocument],
  );

  const navigatePreviewToEditor = useCallback(() => {
    if (!frameDocument) return;
    const position = sourcePositionAtPreviewCenter(frameDocument);
    if (position !== undefined) {
      useDocumentStore.getState().requestJumpToPosition(position);
    }
  }, [frameDocument]);

  useEffect(() => {
    if (!outlineTrackingEnabled || !frameDocument || scrollSyncPaused) return;
    const frame = requestAnimationFrame(() => {
      const position = sourcePositionAtPreviewCenter(frameDocument);
      if (position !== undefined)
        useDocumentStore.setState({ outlineScrollPosition: position });
    });
    return () => cancelAnimationFrame(frame);
  }, [outlineTrackingEnabled, frameDocument, scrollSyncPaused]);

  useEffect(() => {
    if (!frameDocument) return;
    let lastScrollTop = frameDocument.scrollingElement?.scrollTop ?? 0;

    const syncPreviewPosition = () => {
      const scrollTop = frameDocument.scrollingElement?.scrollTop ?? 0;
      if (
        !scrollSyncEnabledRef.current ||
        (frameDocument.scrollingElement &&
          isNavigationScrolling(frameDocument.scrollingElement as HTMLElement))
      ) {
        lastScrollTop = scrollTop;
        return;
      }
      if (
        performance.now() < ignorePreviewScrollUntilRef.current ||
        Math.abs(scrollTop - lastScrollTop) < 0.5
      ) {
        return;
      }
      lastScrollTop = scrollTop;
      const position = sourcePositionAtPreviewCenter(frameDocument);
      if (
        position === undefined ||
        lastPreviewScrollPositionRef.current === position
      ) {
        return;
      }
      lastPreviewScrollPositionRef.current = position;
      onScrollSyncToEditorRef.current?.(position);
    };

    // Observe iframe scrolling consistently while preview content and themes change.
    const previewScrollPollTimer = window.setInterval(syncPreviewPosition, 40);
    return () => window.clearInterval(previewScrollPollTimer);
  }, [frameDocument]);

  useEffect(() => {
    if (
      !frameDocument ||
      !scrollSyncEnabled ||
      scrollSyncPaused ||
      !scrollSyncTarget
    )
      return;

    const frame = requestAnimationFrame(() => {
      const element = sourceElementForPosition(
        frameDocument,
        scrollSyncTarget.position,
      );
      const scrollingElement = frameDocument.scrollingElement;
      if (!element || !scrollingElement) return;
      const rect = element.getBoundingClientRect();
      const viewportHeight = frameDocument.documentElement.clientHeight;
      const maxScrollTop = Math.max(
        0,
        scrollingElement.scrollHeight - viewportHeight,
      );
      const targetScrollTop =
        scrollSyncTarget.position <= 0
          ? 0
          : scrollSyncTarget.position >= markdownSource.length
            ? maxScrollTop
            : Math.max(
                0,
                Math.min(
                  maxScrollTop,
                  scrollingElement.scrollTop +
                    rect.top +
                    rect.height / 2 -
                    viewportHeight / 2,
                ),
              );
      lastPreviewScrollPositionRef.current =
        sourceRangeFromElement(element)?.start ?? scrollSyncTarget.position;
      ignorePreviewScrollUntilRef.current = performance.now() + 120;
      scrollingElement.scrollTop = targetScrollTop;
    });

    return () => cancelAnimationFrame(frame);
  }, [
    frameDocument,
    markdownSource.length,
    scrollSyncEnabled,
    scrollSyncTarget,
    scrollSyncPaused,
  ]);

  useEffect(() => {
    if (!frameDocument) return;
    let lastNavigation: { position: number; timestamp: number } | null = null;
    const navigateEventTargetToEditor = (event: MouseEvent) => {
      const target = event.target;
      if (
        !target ||
        !("closest" in target) ||
        typeof target.closest !== "function"
      ) {
        return;
      }
      if ((target as Element).closest("a[href], summary")) return;
      const element = (target as Element).closest<HTMLElement>(
        SOURCE_ELEMENT_SELECTOR,
      );
      if (!element) return;
      const range = sourceRangeFromElement(element);
      if (!range) return;
      const timestamp = performance.now();
      if (
        lastNavigation?.position === range.start &&
        timestamp - lastNavigation.timestamp < 250
      ) {
        return;
      }
      lastNavigation = { position: range.start, timestamp };
      useDocumentStore.getState().requestJumpToPosition(range.start);
    };
    const handleSecondClick = (event: MouseEvent) => {
      if (event.detail >= 2) navigateEventTargetToEditor(event);
    };
    const handleDoubleClick = (event: MouseEvent) => {
      navigateEventTargetToEditor(event);
    };
    frameDocument.addEventListener("click", handleSecondClick);
    frameDocument.addEventListener("dblclick", handleDoubleClick);
    return () => {
      frameDocument.removeEventListener("click", handleSecondClick);
      frameDocument.removeEventListener("dblclick", handleDoubleClick);
    };
  }, [frameDocument]);

  useEffect(() => {
    if (!frameDocument || !syncNavigationRequest) return;
    if (lastHandledSyncNavigationIdRef.current === syncNavigationRequest.id)
      return;
    lastHandledSyncNavigationIdRef.current = syncNavigationRequest.id;
    if (syncNavigationRequest.direction === "to-preview") {
      navigateEditorToPreview();
    } else {
      navigatePreviewToEditor();
    }
    onSyncNavigationHandled?.(syncNavigationRequest.id);
  }, [
    frameDocument,
    navigateEditorToPreview,
    navigatePreviewToEditor,
    onSyncNavigationHandled,
    syncNavigationRequest,
  ]);

  // Keep the rendered nodes stable while search state changes, so DOM ranges
  // and the user's text selection stay attached to the document.
  const renderedMarkdown = useMemo(() => {
    if (!activeFile || !isMarkdownFile(activeFile)) return null;
    const resolveSource = (source: string | undefined) => {
      if (!source) return source;
      const resolved = resolveMarkdownProjectFile(source, activeFile, files);
      return resolved
        ? `${getAssetUrl(resolved.file.absolutePath)}${resolved.suffix}`
        : source;
    };

    const sourcePositionProps = (node: unknown) => {
      const range = sourceRangeFromNode(node, lineStartOffsets);
      return {
        "data-markdown-source-start": range?.start,
        "data-markdown-source-end": range?.end,
      };
    };

    return frameDocument?.getElementById("write")
      ? createPortal(
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[
              rehypeRaw,
              [rehypeSanitize, markdownHtmlSchema],
              markdownFormatting,
              markdownCommentSource,
              mathEngine === "mathjax" && mathjax ? mathjax : rehypeKatex,
              markdownCodeHighlighting,
            ]}
            components={{
              h1({ node, ...props }) {
                return <h1 {...props} {...sourcePositionProps(node)} />;
              },
              h2({ node, ...props }) {
                return <h2 {...props} {...sourcePositionProps(node)} />;
              },
              h3({ node, ...props }) {
                return <h3 {...props} {...sourcePositionProps(node)} />;
              },
              h4({ node, ...props }) {
                return <h4 {...props} {...sourcePositionProps(node)} />;
              },
              h5({ node, ...props }) {
                return <h5 {...props} {...sourcePositionProps(node)} />;
              },
              h6({ node, ...props }) {
                return <h6 {...props} {...sourcePositionProps(node)} />;
              },
              p({ node, ...props }) {
                return <p {...props} {...sourcePositionProps(node)} />;
              },
              blockquote({ node, ...props }) {
                return <blockquote {...props} {...sourcePositionProps(node)} />;
              },
              pre({ node, ...props }) {
                return <pre {...props} {...sourcePositionProps(node)} />;
              },
              ul({ node, ...props }) {
                return <ul {...props} {...sourcePositionProps(node)} />;
              },
              ol({ node, ...props }) {
                return <ol {...props} {...sourcePositionProps(node)} />;
              },
              li({ node, ...props }) {
                return <li {...props} {...sourcePositionProps(node)} />;
              },
              table({ node, ...props }) {
                return <table {...props} {...sourcePositionProps(node)} />;
              },
              hr({ node, ...props }) {
                return <hr {...props} {...sourcePositionProps(node)} />;
              },
              a({ node: _node, href, children, ...props }) {
                const resolved = href?.startsWith("#")
                  ? { file: activeFile, suffix: href }
                  : resolveMarkdownProjectFile(href, activeFile, files);
                if (resolved) {
                  return (
                    <a
                      href={resolveSource(href)}
                      {...props}
                      onClick={(event) => {
                        event.preventDefault();
                        const request = ++linkRequestRef.current;
                        const fragment = markdownFragment(resolved.suffix);
                        if (fragment === null) {
                          setActiveFile(resolved.file.id);
                          return;
                        }
                        void (async () => {
                          const before = useDocumentStore.getState();
                          const scroll = frameDocument?.scrollingElement;
                          const origin =
                            scroll && frameDocument
                              ? {
                                  fileId: activeFile.id,
                                  name: activeFile.name,
                                  content: activeFile.content,
                                  top: scroll.scrollTop,
                                  left: scroll.scrollLeft,
                                  position:
                                    sourcePositionAtPreviewCenter(
                                      frameDocument,
                                    ) ?? 0,
                                  projectRoot: before.projectRoot,
                                  sessionId: before.agentWorkspaceSessionId,
                                }
                              : null;
                          if (
                            resolved.file.content === undefined &&
                            !resolved.file.isBinary &&
                            resolved.file.type !== "image" &&
                            resolved.file.type !== "pdf"
                          )
                            await before.loadFileContent(resolved.file.id);
                          const state = useDocumentStore.getState();
                          if (
                            request !== linkRequestRef.current ||
                            state.projectRoot !== before.projectRoot ||
                            state.agentWorkspaceSessionId !==
                              before.agentWorkspaceSessionId ||
                            state.fileSelectionRevision !==
                              before.fileSelectionRevision
                          )
                            return;
                          const target = state.files.find(
                            (file) => file.id === resolved.file.id,
                          );
                          if (!target) return;
                          const position =
                            target.content === undefined
                              ? null
                              : markdownLinkPosition(target.content, fragment);
                          setActiveFile(target.id);
                          if (position !== null) {
                            if (origin)
                              setLinkReturn({
                                ...origin,
                                selectionRevision:
                                  useDocumentStore.getState()
                                    .fileSelectionRevision,
                              });
                            state.requestJumpToPosition(position);
                            setLinkNavigation({
                              fileId: target.id,
                              position,
                              fragment,
                            });
                          }
                        })().catch(() =>
                          toast.error("Could not open linked location"),
                        );
                      }}
                      onAuxClick={(event) => {
                        if (event.button !== 1) return;
                        event.preventDefault();
                        openFileInBackground(resolved.file.id);
                      }}
                    >
                      {children}
                    </a>
                  );
                }
                const isExternal = /^(?:https?:|mailto:)/i.test(href ?? "");
                return (
                  <a
                    href={href}
                    {...props}
                    target={isExternal ? "_blank" : undefined}
                    rel={isExternal ? "noreferrer" : undefined}
                  >
                    {children}
                  </a>
                );
              },
              img({ node: _node, src, alt, ...props }) {
                return (
                  <img src={resolveSource(src)} alt={alt ?? ""} {...props} />
                );
              },
            }}
          >
            {activeFile.content ?? ""}
          </ReactMarkdown>,
          frameDocument.getElementById("write")!,
        )
      : null;
  }, [
    activeFile,
    files,
    frameDocument,
    lineStartOffsets,
    setActiveFile,
    openFileInBackground,
    mathEngine,
    mathjax,
  ]);

  useEffect(() => {
    if (
      !linkNavigation ||
      !frameDocument ||
      activeFile?.id !== linkNavigation.fileId
    )
      return;
    const frame = requestAnimationFrame(() => {
      const scroll = frameDocument.scrollingElement as HTMLElement | null;
      if (scroll) {
        lastPreviewScrollPositionRef.current = linkNavigation.position;
        ignorePreviewScrollUntilRef.current = performance.now() + 250;
        if (linkNavigation.scroll) {
          cancelNavigationScroll(scroll);
          scroll.scrollTo({ ...linkNavigation.scroll, behavior: "instant" });
        } else {
          const fragment = linkNavigation.fragment ?? "";
          const element =
            frameDocument.getElementById(markdownAnchorId(fragment)) ??
            frameDocument.getElementsByName(markdownAnchorId(fragment))[0] ??
            sourceElementForPosition(frameDocument, linkNavigation.position);
          if (element)
            scrollForNavigation(scroll, {
              top: scroll.scrollTop + element.getBoundingClientRect().top - 24,
            });
        }
      }
      setLinkNavigation(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [activeFile?.id, frameDocument, linkNavigation, renderedMarkdown]);

  useEffect(() => {
    if (
      !frameDocument ||
      !linkReturn ||
      linkNavigation ||
      linkReturn.fileId !== activeFileId
    )
      return;
    const scroll = frameDocument.scrollingElement as HTMLElement | null;
    if (!scroll) return;
    let previousTop = scroll.scrollTop;
    const clearPassedReturn = () => {
      const top = scroll.scrollTop;
      const previousDistance = previousTop - linkReturn.top;
      previousTop = top;
      // The outgoing jump starts at the return point; only later scrolling
      // back to (or across) that point should dismiss it.
      if (isNavigationScrolling(scroll) || Math.abs(previousDistance) <= 1)
        return;
      if (
        previousDistance > 0
          ? top <= linkReturn.top + 1
          : top >= linkReturn.top - 1
      )
        setLinkReturn(null);
    };
    frameDocument.addEventListener("scroll", clearPassedReturn, {
      passive: true,
    });
    return () => frameDocument.removeEventListener("scroll", clearPassedReturn);
  }, [activeFileId, frameDocument, linkNavigation, linkReturn]);

  if (!activeFile || !isMarkdownFile(activeFile)) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Select a Markdown file to preview.
      </div>
    );
  }

  return (
    <div
      ref={searchScope}
      tabIndex={-1}
      data-preview-pane
      className="flex h-full min-h-0 flex-col bg-background outline-none"
      data-testid="markdown-preview"
      style={previewPanelStyle}
    >
      <WorkspacePanelHeader
        trailingContent={<div ref={setCommentToolbar} />}
        hasTrailingContent={commentToolbarVisible}
        className="flex h-12 shrink-0 items-center border-border border-b bg-background px-2"
        data-testid="markdown-preview-toolbar"
      >
        <div className="flex min-w-0 items-center gap-1">
          <DropdownMenu
            modal={false}
            open={themeMenuOpen}
            onOpenChange={(open) => {
              setThemeMenuOpen(open);
              if (!open) setShowAllTyporaThemes(false);
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                aria-label="Markdown preview settings"
                variant="outline"
                size="sm"
                className="h-7 w-auto min-w-28 max-w-64 gap-2 bg-background px-3 font-normal text-xs"
              >
                <ThemeModeIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground"
                  data-theme-mode-icon={themeModeIcon}
                  data-testid="markdown-theme-icon"
                />
                <span className="truncate">{selectedThemeLabel}</span>
                {loadingMath ? (
                  <LoaderIcon
                    className="size-3.5 shrink-0 animate-spin"
                    aria-label="Loading MathJax"
                  />
                ) : (
                  <ChevronDownIcon className="size-3.5 shrink-0 opacity-50" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DialogResizeTransition animateWidth>
              {(resizeRef) => (
                <DropdownMenuContent
                  ref={resizeRef}
                  side="bottom"
                  sideOffset={8}
                  align="start"
                  className="w-max max-w-[min(20rem,calc(100vw-2rem))]"
                >
                  {showAllTyporaThemes ? (
                    <>
                      <DropdownMenuItem
                        aria-label="Back to preview settings"
                        onSelect={(event) => {
                          event.preventDefault();
                          showThemeMenuRoot();
                        }}
                      >
                        <ChevronLeftIcon className="size-3.5" />
                        All Typora themes
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <div
                        ref={themeListRef}
                        data-testid="markdown-all-typora-themes"
                        className="app-scrollbar overflow-y-auto"
                        style={{
                          maxHeight:
                            "min(24rem, calc(var(--radix-dropdown-menu-content-available-height) - 3rem))",
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowLeft") {
                            event.preventDefault();
                            event.stopPropagation();
                            showThemeMenuRoot();
                          }
                        }}
                      >
                        <DropdownMenuRadioGroup
                          value={selectedThemeId}
                          onValueChange={handleThemeChange}
                        >
                          {["Theme folder", "Project CSS"].map((group) => {
                            const themes = typoraThemes.filter(
                              (theme) => theme.group === group,
                            );
                            return themes.length ? (
                              <div key={group}>
                                <DropdownMenuLabel>{group}</DropdownMenuLabel>
                                {themes.map((theme) => (
                                  <DropdownMenuRadioItem
                                    onSelect={(event) => event.preventDefault()}
                                    key={theme.path}
                                    value={theme.id}
                                    indicatorPosition="end"
                                    indicator={<CheckIcon className="size-4" />}
                                  >
                                    <MarkdownThemeSwatch
                                      path={theme.path}
                                      css={theme.css}
                                    />
                                    <span className="truncate">
                                      {theme.label}
                                    </span>
                                  </DropdownMenuRadioItem>
                                ))}
                              </div>
                            ) : null;
                          })}
                        </DropdownMenuRadioGroup>
                      </div>
                    </>
                  ) : (
                    <>
                      <DropdownMenuLabel>Math engine</DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={mathEngine}
                        onValueChange={(value) => {
                          setMathEngine(
                            value === "mathjax" ? "mathjax" : "katex",
                          );
                          broadcastSettingsChanged();
                        }}
                      >
                        <DropdownMenuRadioItem
                          onSelect={(event) => event.preventDefault()}
                          indicatorPosition="end"
                          indicator={<CheckIcon className="size-4" />}
                          value="katex"
                        >
                          <span>
                            KaTeX{" "}
                            <span className="text-muted-foreground">
                              (fast)
                            </span>
                          </span>
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem
                          onSelect={(event) => event.preventDefault()}
                          indicatorPosition="end"
                          indicator={<CheckIcon className="size-4" />}
                          value="mathjax"
                        >
                          <span>
                            MathJax{" "}
                            <span className="text-muted-foreground">
                              (OpenReview)
                            </span>
                          </span>
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Theme</DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={selectedThemeId}
                        onValueChange={handleThemeChange}
                      >
                        <DropdownMenuRadioItem
                          onSelect={(event) => event.preventDefault()}
                          indicatorPosition="end"
                          indicator={<CheckIcon className="size-4" />}
                          value={GITHUB_LIGHT_MARKDOWN_THEME_ID}
                        >
                          <MarkdownThemeSwatch
                            palette={GITHUB_LIGHT_MARKDOWN_THEME_COLORS}
                          />
                          GitHub Light
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem
                          onSelect={(event) => event.preventDefault()}
                          indicatorPosition="end"
                          indicator={<CheckIcon className="size-4" />}
                          value={GITHUB_DARK_MARKDOWN_THEME_ID}
                        >
                          <MarkdownThemeSwatch
                            palette={GITHUB_DARK_MARKDOWN_THEME_COLORS}
                          />
                          GitHub Dark
                        </DropdownMenuRadioItem>
                        {recentThemes.length > 0 && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel>
                              Recent Typora themes
                            </DropdownMenuLabel>
                            {recentThemes.map((theme) => (
                              <DropdownMenuRadioItem
                                onSelect={(event) => event.preventDefault()}
                                key={theme.path}
                                value={theme.id}
                                indicatorPosition="end"
                                indicator={<CheckIcon className="size-4" />}
                              >
                                <MarkdownThemeSwatch
                                  path={theme.path}
                                  css={theme.css}
                                />
                                <span className="truncate">{theme.label}</span>
                              </DropdownMenuRadioItem>
                            ))}
                          </>
                        )}
                        {typoraThemes.length > 0 && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              ref={allThemesButtonRef}
                              onSelect={(event) => {
                                event.preventDefault();
                                setShowAllTyporaThemes(true);
                              }}
                            >
                              All Typora themes
                              <ChevronRightIcon className="ml-auto size-3.5" />
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuRadioGroup>
                    </>
                  )}
                </DropdownMenuContent>
              )}
            </DialogResizeTransition>
          </DropdownMenu>
          <Hint content={isExportingPdf ? "Exporting PDF…" : "Export PDF"}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Export Markdown as PDF"
              onClick={handleExportPdf}
              disabled={!frameDocument || isExportingPdf || loadingMath}
            >
              {isExportingPdf ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <DownloadIcon className="size-3.5" />
              )}
            </Button>
          </Hint>
        </div>
        <div data-window-drag-region className="flex-1 self-stretch" />
      </WorkspacePanelHeader>
      <div ref={setCommentPanel} className="shrink-0" />
      <div className="relative flex min-h-0 flex-1">
        <PreviewSearchPanel search={search} {...markdownSearch} />
        <iframe
          ref={frameRef}
          data-panel-content-focus=""
          title={`${activeFile.name} preview`}
          className="min-h-0 flex-1 border-0 bg-white dark:bg-[#0d1117]"
          sandbox="allow-popups allow-same-origin"
          srcDoc={FRAME_SOURCE}
          onLoad={() =>
            setFrameDocument(frameRef.current?.contentDocument ?? null)
          }
        />
        {linkReturn && (
          <div className="absolute top-3 right-3 z-10 inline-flex items-center rounded-lg border border-border bg-background/95 text-xs shadow-sm">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                ++linkRequestRef.current;
                setActiveFile(linkReturn.fileId);
                useDocumentStore
                  .getState()
                  .requestJumpToPosition(linkReturn.position);
                setLinkNavigation({
                  fileId: linkReturn.fileId,
                  position: linkReturn.position,
                  scroll: { top: linkReturn.top, left: linkReturn.left },
                });
                setLinkReturn(null);
              }}
            >
              <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
              {linkReturn.fileId === activeFileId
                ? "Jump back"
                : `Jump back to ${linkReturn.name}`}
            </button>
            <Hint content="Dismiss">
              <button
                type="button"
                aria-label="Dismiss jump back"
                className="mr-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setLinkReturn(null)}
              >
                <XIcon className="size-3" aria-hidden="true" />
              </button>
            </Hint>
          </div>
        )}
        {frameDocument && (
          <MarkdownComments
            key={activeFile.id}
            editorVisible={editorVisible}
            layoutAnimating={layoutAnimating}
            frameDocument={frameDocument}
            toolbarHost={commentToolbar}
            onToolbarVisibilityChange={setCommentToolbarVisible}
            panelHost={commentPanel}
            source={markdownSource}
            filePath={activeFile.relativePath}
          />
        )}
      </div>
      {renderedMarkdown}
    </div>
  );
}
