import { useState } from "react";
import { ArrowRight, Menu, Send, XIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { onSectionLinkClick } from "@/lib/scroll";

const EASE = "cubic-bezier(0.25,0.1,0.25,1)";

function RollText({ label }: { label: string }) {
  return (
    <span className="flex flex-col overflow-hidden h-[20px] leading-[20px]">
      <span
        className="transition-transform duration-500 group-hover:-translate-y-1/2"
        style={{ transitionTimingFunction: EASE }}
      >
        <span className="block h-[20px]">{label}</span>
        <span className="block h-[20px]">{label}</span>
      </span>
    </span>
  );
}

type NavItem =
  | { label: string; to: "/download" | "/" }
  | { label: string; href: string; external?: boolean };

const NAV_ITEMS: NavItem[] = [
  { label: "Network", href: "/#marketplace" },
  { label: "Download", to: "/download" },
  { label: "How it works", href: "/#legion" },
  { label: "GitHub", href: "https://github.com/DawnOnBase", external: true },
];

export default function SiteNav({ variant = "light" }: { variant?: "light" | "muted" }) {
  const [menuOpen, setMenuOpen] = useState(false);

  const pillBg = variant === "muted" ? "bg-[#EFEFEF]" : "bg-white";
  const iconBg = variant === "muted" ? "bg-white" : "bg-gray-100";
  const iconBgHover = variant === "muted" ? "hover:bg-gray-100" : "hover:bg-gray-200";

  return (
    <div className="relative z-20 mx-auto w-full max-w-[1440px] p-2 sm:p-3">
      <nav className={`${pillBg} rounded-full relative grid grid-cols-[auto_1fr_auto] items-center gap-2`} style={{ padding: 5 }}>
        {/* Left: logo */}
        <Link to="/" className="text-[15px] font-medium text-gray-900 tracking-tight pl-3 shrink-0 relative z-10">
          Dawn.
        </Link>

        {/* Center: nav */}
        <div className="hidden md:flex items-center justify-center gap-6 lg:gap-8 absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 w-auto">
          {NAV_ITEMS.map((l) =>
            "to" in l ? (
              <Link key={l.label} to={l.to} className="text-[14px] text-gray-900 hover:opacity-70 transition-opacity whitespace-nowrap">
                {l.label}
              </Link>
            ) : (
              <a
                key={l.label}
                href={l.href}
                {...(l.external
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : { onClick: (e) => onSectionLinkClick(e, l.href) })}
                className="text-[14px] text-gray-900 hover:opacity-70 transition-opacity whitespace-nowrap"
              >
                {l.label}
              </a>
            )
          )}
        </div>

        {/* Right: actions */}
        <div className="hidden md:flex items-center gap-3 lg:gap-4 pr-1 justify-end relative z-10 col-start-3">
          <a
            href="https://t.me/dawnonbase"
            target="_blank"
            rel="noopener noreferrer"
            className={`w-8 h-8 rounded-full ${iconBg} ${iconBgHover} flex items-center justify-center transition-colors`}
            aria-label="Telegram"
          >
            <Send size={14} className="text-gray-700" />
          </a>
          <a
            href="https://x.com/dawnonbase"
            target="_blank"
            rel="noopener noreferrer"
            className={`w-8 h-8 rounded-full ${iconBg} ${iconBgHover} flex items-center justify-center transition-colors`}
            aria-label="X"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" className="text-gray-700">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
          <Link
            to="/download"
            className="group bg-[#F29B8A] hover:bg-[#E07F73] text-gray-900 text-[13px] font-medium rounded-full pl-4 lg:pl-5 pr-2 py-1.5 flex items-center gap-2 lg:gap-3 shrink-0 transition-colors"
          >
            <RollText label="Download agent" />
            <span
              className="w-6 h-6 bg-gray-900 rounded-full flex items-center justify-center transition-transform duration-500 group-hover:-rotate-45"
              style={{ transitionTimingFunction: EASE }}
            >
              <ArrowRight size={12} className="text-[#F29B8A]" />
            </span>
          </Link>
        </div>

        {/* Mobile menu trigger */}
        <button
          onClick={() => setMenuOpen(true)}
          className="md:hidden bg-gray-900 text-white rounded-full p-2.5 justify-self-end col-start-3"
          aria-label="Open menu"
        >
          <Menu size={18} />
        </button>
      </nav>

      {menuOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMenuOpen(false)} />
          <div
            className="absolute left-0 right-0 bottom-0 mx-3 mb-3 bg-white rounded-2xl p-6"
            style={{ animation: "slideUp 0.5s cubic-bezier(0.32,0.72,0,1)" }}
          >
            <div className="flex items-center justify-end mb-6">
              <button onClick={() => setMenuOpen(false)} className="bg-gray-900 text-white rounded-full p-2.5">
                <XIcon size={18} />
              </button>
            </div>
            <div className="flex flex-col gap-3 mb-8">
              {NAV_ITEMS.map((l) =>
                "to" in l ? (
                  <Link
                    key={l.label}
                    to={l.to}
                    onClick={() => setMenuOpen(false)}
                    className="text-[28px] leading-[32px] font-medium text-gray-900"
                  >
                    {l.label}
                  </Link>
                ) : (
                  <a
                    key={l.label}
                    href={l.href}
                    {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    onClick={(e) => {
                      if (!l.external) onSectionLinkClick(e, l.href);
                      setMenuOpen(false);
                    }}
                    className="text-[28px] leading-[32px] font-medium text-gray-900"
                  >
                    {l.label}
                  </a>
                )
              )}
            </div>
            <Link
              to="/download"
              onClick={() => setMenuOpen(false)}
              className="group w-full bg-[#F29B8A] text-gray-900 text-[14px] font-medium rounded-full pl-6 pr-2 py-2 flex items-center justify-between"
            >
              <RollText label="Download agent" />
              <span
                className="w-8 h-8 bg-gray-900 rounded-full flex items-center justify-center transition-transform duration-500 group-hover:-rotate-45"
                style={{ transitionTimingFunction: EASE }}
              >
                <ArrowRight size={14} className="text-[#F29B8A]" />
              </span>
            </Link>
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
