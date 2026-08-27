import { useEffect, useState } from "react";

const ICON = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** Copies a text field's contents, acknowledging with a tick before settling back. */
export function CopyButton({ text, title }: { text: string; title: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      className={`copy nodrag${copied ? " copied" : ""}`}
      title={copied ? "Copied" : title}
      aria-label={title}
      disabled={!text}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          // Clipboard access can be refused; leave the icon untouched rather than lying.
        }
      }}
    >
      <svg {...ICON} width="13" height="13" aria-hidden="true">
        {copied ? (
          <path d="M20 6 9 17l-5-5" />
        ) : (
          <>
            <rect x="8" y="8" width="13" height="13" rx="2" />
            <path d="M5 16a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2" />
          </>
        )}
      </svg>
    </button>
  );
}
