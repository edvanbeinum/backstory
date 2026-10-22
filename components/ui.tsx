"use client";

import { useEffect, useState } from "react";

import { CheckIcon, CopyIcon } from "./icons";

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "open" | "merged" | "closed" | "draft" | "attention";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "border-[var(--border)] text-[var(--fg-muted)]",
    open: "border-transparent bg-[#1f883d] text-white",
    merged: "border-transparent bg-[var(--done)] text-white",
    closed: "border-transparent bg-[#cf222e] text-white",
    draft: "border-transparent bg-[var(--fg-muted)] text-white",
    attention: "border-[var(--attention)] text-[var(--attention)]",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-[1px] text-[11px] font-medium leading-5 ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  href,
  variant = "default",
  size = "md",
  title,
  disabled,
  className = "",
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  /** Makes it a link that opens in a new window, styled as a button */
  href?: string;
  variant?: "default" | "primary" | "invisible";
  size?: "sm" | "md";
  title?: string;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  const base =
    "inline-flex items-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const sizes = {
    sm: "px-2 py-[3px] text-[12px]",
    md: "px-3 py-[5px] text-[14px]",
  };
  const variants = {
    default:
      "border border-[var(--border)] bg-[var(--canvas-subtle)] text-[var(--fg)] hover:bg-[var(--border-muted)]",
    primary:
      "border border-[#1f883d] bg-[#1f883d] text-white hover:bg-[#1a7f37]",
    invisible:
      "border border-transparent text-[var(--fg-muted)] hover:bg-[var(--canvas-subtle)] hover:text-[var(--fg)]",
  };
  if (href)
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={title}
        onClick={onClick}
        className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      >
        {children}
      </a>
    );
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * Copy text to the clipboard, with a selection-based fallback — the
 * Clipboard API needs a secure context; localhost qualifies, but belt and
 * braces. Returns whether the copy landed.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand("copy");
    } finally {
      document.body.removeChild(area);
    }
  }
}

/**
 * Copy-to-clipboard with a confirmation state. This is the app's whole output
 * path — nothing is ever posted to GitHub — so it needs to be unmistakable
 * when a copy actually landed.
 */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  title,
  variant = "default",
  size = "sm",
  className = "",
}: {
  /**
   * A thunk is resolved at click time — use it for anything that changes
   * without re-rendering this button, such as the current URL after a
   * history.replaceState.
   */
  value: string | (() => string);
  label?: string;
  copiedLabel?: string;
  title?: string;
  variant?: "default" | "primary" | "invisible";
  size?: "sm" | "md";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    const text = typeof value === "function" ? value() : value;
    if (await copyToClipboard(text)) setCopied(true);
  };

  return (
    <Button
      onClick={copy}
      title={title}
      variant={variant}
      size={size}
      className={className}
    >
      {copied ? (
        <CheckIcon size={14} className="text-[var(--success)]" />
      ) : (
        <CopyIcon size={14} />
      )}
      {copied ? copiedLabel : label}
    </Button>
  );
}

const UNITS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [7, "day"],
  [4.345, "week"],
  [12, "month"],
  [Number.POSITIVE_INFINITY, "year"],
];

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const formatter = new Intl.RelativeTimeFormat(undefined, {
    numeric: "auto",
  });
  let delta = (then - Date.now()) / 1000;

  for (const [step, unit] of UNITS) {
    if (Math.abs(delta) < step) {
      return formatter.format(Math.round(delta), unit);
    }
    delta /= step;
  }
  return "";
}

/**
 * Rendered only after mount — server and client would otherwise disagree about
 * "3 minutes ago" and React would report a hydration mismatch.
 */
export function RelativeTime({ iso }: { iso: string }) {
  const [text, setText] = useState("");
  // eslint-disable-next-line react-hooks/set-state-in-effect -- server and client would disagree on the time
  useEffect(() => setText(relativeTime(iso)), [iso]);
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {text}
    </time>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--fg-muted)] ${className}`}
    />
  );
}

/** Text with each `backticked` name in monospace */
export function Ticked({ text }: { text: string }) {
  return (
    <span>
      {text.split("`").map((part, i) =>
        !part ? null : i % 2 ? (
          <code key={i} className="ticked">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </span>
  );
}
