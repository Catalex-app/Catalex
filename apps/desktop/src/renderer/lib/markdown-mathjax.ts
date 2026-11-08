import rehypeMathjax from "rehype-mathjax/svg";

/** Bundled SVG output needs neither remote fonts nor scripts in the preview. */
export default function markdownMathjax() {
  return rehypeMathjax({
    svg: { fontCache: "none" },
    // Math notation only: exclude HTML styling, links, and dynamic packages.
    tex: {
      packages: [
        "base",
        "ams",
        "newcommand",
        "configmacros",
        "boldsymbol",
        "mathtools",
        "cancel",
        "noundefined",
      ],
    },
  });
}
