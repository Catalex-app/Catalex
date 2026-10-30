import { createRoot } from "react-dom/client";
import { PdfCommentsHarness } from "./harnesses/pdf-comments-harness";
import { installSelectionBoundaries } from "../lib/selection-boundaries";
import { installFocusModality } from "../lib/focus-modality";
import "../styles/globals.css";

// Separate build entry: never enabled in the shipped application.
installSelectionBoundaries();
installFocusModality();
createRoot(document.getElementById("root")!).render(<PdfCommentsHarness />);
