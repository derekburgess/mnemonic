/** Drawn rather than the "×" glyph, whose font metrics never centre in a square button. */
export function DeleteButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button className="icon nodrag" onClick={onClick} title={title} aria-label={title}>
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}
