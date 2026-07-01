import { type MouseEvent } from "react";

/** "/#marketplace" | "#marketplace" -> "marketplace" */
function sectionId(href: string): string {
  return href.replace(/^\/?#/, "");
}

/**
 * Click handler for in-page section anchors (header + footer). Smooth-scrolls to
 * the target section and keeps the URL clean — no "/#section" stamped on. Falls
 * through to normal navigation when the section isn't on the current page (e.g. a
 * footer link clicked from /download), so the destination can scroll on arrival.
 */
export function onSectionLinkClick(e: MouseEvent<HTMLAnchorElement>, href: string): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById(sectionId(href));
  if (!el) return; // cross-page: let the browser navigate to "/#section"
  e.preventDefault();
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  // replaceState (not push) → no history spam, and the hash never shows in the URL.
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

/**
 * On a fresh load that arrived with a "#section" hash (e.g. from another page),
 * smooth-scroll to it once the DOM is laid out, then strip the hash. Call on mount.
 */
export function scrollToInitialHash(): void {
  if (typeof window === "undefined" || !window.location.hash) return;
  const el = document.getElementById(window.location.hash.slice(1));
  if (!el) return;
  requestAnimationFrame(() => {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  });
}
