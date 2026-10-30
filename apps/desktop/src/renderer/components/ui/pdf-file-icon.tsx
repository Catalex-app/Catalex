export function PdfFileIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
      <path d="M14 2v5h5" />
      <text
        x="12"
        y="17.2"
        textAnchor="middle"
        fontSize="5"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
      >
        PDF
      </text>
    </svg>
  );
}
