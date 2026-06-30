import { ArrowRight, Github, Send } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { onSectionLinkClick } from "@/lib/scroll";


const EASE = "cubic-bezier(0.25,0.1,0.25,1)";

const SETTLEMENT_URL =
  "https://basescan.org/address/0xc27C681cE93a63C0987226CDaC7b66232018651E";

type FooterLink = { label: string; to?: "/download" | "/" | "/support"; href?: string; external?: boolean };
const COLUMNS: { heading: string; links: FooterLink[] }[] = [
  {
    heading: "Network",
    links: [
      { label: "Network", href: "/#marketplace" },
      { label: "How it works", href: "/#legion" },
      { label: "Contract", href: SETTLEMENT_URL, external: true },
    ],
  },
  {
    heading: "Build",
    links: [
      { label: "Download agent", to: "/download" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "/#about" },
      { label: "Support", to: "/support" },
      { label: "Home", to: "/" },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="bg-[#EFEFEF] pt-16 sm:pt-20 lg:pt-28 pb-8 sm:pb-10">
      <div className="mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-12">
        <div className="h-0.5 w-16 bg-[#F29B8A] mb-10 sm:mb-14 lg:mb-16" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr] gap-10 lg:gap-8 pb-12 sm:pb-16 lg:pb-20">
          <div className="flex flex-col gap-6 max-w-md">
            <span className="text-[15px] font-medium text-[#F29B8A]">Dawn.</span>
            <p className="text-[14px] text-gray-600 leading-relaxed">

              A passive compute network on Base. Earn USDC by letting your idle laptop run micro-jobs. Close your laptop. Get paid by dawn.
            </p>
            <div className="flex items-center gap-3">
              <a
                href="https://t.me/dawnonbase"
                target="_blank"
                rel="noopener noreferrer"
                className="w-9 h-9 rounded-full bg-gray-900 flex items-center justify-center hover:bg-gray-700 transition-colors"
                aria-label="Telegram"
              >
                <Send size={15} className="text-white" />
              </a>
              <a
                href="https://x.com/dawnonbase"
                target="_blank"
                rel="noopener noreferrer"
                className="w-9 h-9 rounded-full bg-gray-900 flex items-center justify-center hover:bg-gray-700 transition-colors"
                aria-label="X"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" className="text-white">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </a>
              <a
                href="https://github.com/DawnOnBase"
                target="_blank"
                rel="noopener noreferrer"
                className="w-9 h-9 rounded-full bg-gray-900 flex items-center justify-center hover:bg-gray-700 transition-colors"
                aria-label="GitHub"
              >
                <Github size={15} className="text-white" />
              </a>
            </div>
            <Link to="/download" className="group bg-gray-900 text-white text-[13px] font-medium rounded-full pl-5 pr-2 py-2 inline-flex items-center gap-3 self-start">
              <span>Download agent</span>
              <span
                className="w-6 h-6 bg-white rounded-full flex items-center justify-center transition-transform duration-500 group-hover:-rotate-45"
                style={{ transitionTimingFunction: EASE }}
              >
                <ArrowRight size={12} className="text-gray-900" />
              </span>
            </Link>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.heading} className="flex flex-col gap-3">
              <span className="text-[12px] uppercase tracking-wider text-gray-500 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#F29B8A]" />
                {col.heading}
              </span>
              {col.links.map((l) =>
                l.to ? (
                  <Link key={l.label} to={l.to} className="text-[14px] text-gray-900 hover:opacity-70 transition-opacity">
                    {l.label}
                  </Link>
                ) : (
                  <a
                    key={l.label}
                    href={l.href}
                    {...(l.external
                      ? { target: "_blank", rel: "noopener noreferrer" }
                      : { onClick: (e) => onSectionLinkClick(e, l.href!) })}
                    className="text-[14px] text-gray-900 hover:opacity-70 transition-opacity"
                  >
                    {l.label}
                    {l.external ? " ↗" : ""}
                  </a>
                )
              )}
            </div>
          ))}
        </div>

        <div className="pt-6 border-t border-gray-300 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <span className="text-[12px] sm:text-[13px] text-gray-600 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#F29B8A]" />
            © {new Date().getFullYear()} Dawn. Settles on Base.
          </span>
          <a
            href={SETTLEMENT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] sm:text-[13px] text-gray-600 hover:text-gray-900 transition-colors font-mono"
          >
            Settlement contract: 0xc27C…651E ↗
          </a>
        </div>
      </div>
    </footer>
  );
}
