export interface ExternalTemplateSource {
  id:
    | "ctan-conference"
    | "ctan-journal"
    | "ieee"
    | "acm"
    | "springer"
    | "elsevier";
  name: string;
  description: string;
  badge: string;
  url: string;
}

export const EXTERNAL_TEMPLATE_SOURCES: readonly ExternalTemplateSource[] = [
  {
    id: "ctan-conference",
    name: "CTAN Conference Formats",
    description:
      "Open archive packages and classes for conference papers and proceedings.",
    badge: "Open archive",
    url: "https://ctan.org/topic/confproc",
  },
  {
    id: "ctan-journal",
    name: "CTAN Journal Formats",
    description:
      "Open archive packages and classes for journal articles and submissions.",
    badge: "Open archive",
    url: "https://ctan.org/topic/journalpub",
  },
  {
    id: "ieee",
    name: "IEEE Template Selector",
    description:
      "Official IEEE template lookup by publication, available in LaTeX and Word.",
    badge: "Publisher",
    url: "https://template-selector.ieee.org/",
  },
  {
    id: "acm",
    name: "ACM Article Template",
    description:
      "Official ACM article and proceedings formats, including the acmart workflow.",
    badge: "Publisher",
    url: "https://www.acm.org/publications/proceedings-template",
  },
  {
    id: "springer",
    name: "Springer Nature",
    description:
      "Official LaTeX support and template packages for journals and proceedings.",
    badge: "Publisher",
    url: "https://www.springernature.com/gp/authors/campaigns/latex-author-support",
  },
  {
    id: "elsevier",
    name: "Elsevier",
    description:
      "Official LaTeX instructions and downloads for Elsevier submissions.",
    badge: "Publisher",
    url: "https://www.elsevier.com/en-gb/researcher/author/policies-and-guidelines/latex-instructions",
  },
];
