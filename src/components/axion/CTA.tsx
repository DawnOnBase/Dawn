import { ArrowRight } from "lucide-react";
import { Link } from "@tanstack/react-router";

const EASE = "cubic-bezier(0.25,0.1,0.25,1)";

export default function CTA() {
  return (
    <section className="bg-white pt-16 sm:pt-20 lg:pt-28 pb-16 sm:pb-20 lg:pb-28">
      <div className="mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-12">
        <div
          className="relative overflow-hidden rounded-3xl bg-gray-900 text-white px-6 sm:px-10 lg:px-16 py-14 sm:py-20 lg:py-28"
        >
          {/* Glow accent */}
          <div
            className="pointer-events-none absolute -top-32 -right-32 w-[420px] h-[420px] rounded-full opacity-40 blur-3xl"
            style={{ background: "radial-gradient(circle, #F29B8A 0%, transparent 70%)" }}
          />
          <div
            className="pointer-events-none absolute -bottom-40 -left-20 w-[420px] h-[420px] rounded-full opacity-20 blur-3xl"
            style={{ background: "radial-gradient(circle, #F29B8A 0%, transparent 70%)" }}
          />

          <div className="relative flex items-center gap-3 mb-8 sm:mb-10">
            <span className="w-2 h-2 rounded-full bg-[#F29B8A]" />
            <span className="text-[12px] sm:text-[13px] uppercase tracking-[0.18em] text-gray-400">
              Live on Base testnet
            </span>
          </div>

          <h2
            className="relative font-medium max-w-[18ch]"
            style={{
              fontSize: "clamp(2rem,6vw,4.4rem)",
              lineHeight: 1.05,
              letterSpacing: "-0.035em",
            }}
          >
            Download Dawn and earn while you{" "}
            <span className="italic font-light text-[#F29B8A]">sleep</span>.
          </h2>

          <p className="relative mt-6 sm:mt-8 max-w-[52ch] text-[15px] sm:text-[17px] leading-[1.55] text-gray-400">
            Install the lightweight agent, connect your Base wallet, and start earning USDC from idle compute. No CLI, no Docker, no configuration.
          </p>

          <div className="relative mt-10 sm:mt-12 flex flex-col sm:flex-row gap-4 sm:gap-5">
            <Link to="/download" className="group bg-[#F29B8A] hover:bg-[#E07F73] text-gray-900 text-[14px] font-medium rounded-full pl-6 pr-2 py-2.5 inline-flex items-center gap-3 transition-colors self-start">
              <span>Download agent</span>
              <span
                className="w-8 h-8 bg-gray-900 rounded-full flex items-center justify-center transition-transform duration-500 group-hover:-rotate-45"
                style={{ transitionTimingFunction: EASE }}
              >
                <ArrowRight size={14} className="text-[#F29B8A]" />
              </span>
          </Link>

          </div>
        </div>
      </div>
    </section>
  );
}
