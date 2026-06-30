import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { ChromaFlow, FilmGrain, FlutedGlass, Shader, Swirl } from "shaders/react";
import { installWebGLShaderNameFix } from "@/lib/webgl-shader-name-fix";
import SiteNav from "./SiteNav";

// The hero shader fails to compile on strict/software WebGL drivers because
// the shaders library emits reserved "__" GLSL identifiers. Install the fix at
// module load — before this module's <Shader> ever mounts and compiles.
installWebGLShaderNameFix();

// Official Base brand symbol (Base Blue #0052FF).
const BaseIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 111 111" className={className} aria-hidden="true">
    <path
      fill="#0052FF"
      d="M54.921 110.034C85.359 110.034 110.034 85.402 110.034 55.017C110.034 24.6319 85.359 0 54.921 0C26.0432 0 2.35281 22.1714 0 50.3923H72.8467V59.6416H3.9565e-07C2.35281 87.8625 26.0432 110.034 54.921 110.034Z"
    />
  </svg>
);

const EASE = "cubic-bezier(0.25,0.1,0.25,1)";

export default function Hero() {
  return (
    <section
      className="relative flex flex-col min-h-[640px] sm:min-h-[720px] lg:min-h-screen"
      style={{ backgroundColor: "#EFEFEF" }}
    >
      {/* Animated CSS background — always rendered. The WebGL shader below
          paints over it on capable devices; on mobile/low-power where the
          shader can't render, this stays visible instead of a flat grey. */}
      <div className="hero-fallback absolute inset-0 z-0" aria-hidden="true" />

      {/* Shader stack — rendered unconditionally (in the initial tree) so the
          shaders/three canvas initializes and sizes correctly. The benign
          "VALIDATE_STATUS" warning some GPUs emit is silenced above. The CSS
          background behind only shows if WebGL is entirely unavailable. */}
      <div className="absolute inset-0 z-10 pointer-events-none overflow-hidden">
        <Shader style={{ width: "100%", height: "100%" }}>
          <Swirl colorA="#ffffff" colorB="#f0f0f0" detail={1.7} />
          <ChromaFlow
            baseColor="#ffffff"
            downColor="#F29B8A"
            leftColor="#F29B8A"
            rightColor="#F29B8A"
            upColor="#F29B8A"
            momentum={13}
            radius={3.5}
          />
          <FlutedGlass
            aberration={0.61}
            angle={31}
            frequency={8}
            highlight={0.12}
            highlightSoftness={0}
            lightAngle={-90}
            refraction={4}
            shape="rounded"
            softness={1}
            speed={0.15}
          />
          <FilmGrain strength={0.05} />
        </Shader>
      </div>

      <SiteNav variant="light" />

      {/* Spacer */}
      <div className="flex-1" />

      {/* Hero content */}
      <div className="relative z-20 mx-auto w-full max-w-[1440px] px-5 sm:px-8 lg:px-12 pb-14 sm:pb-16 lg:pb-20">
        <h1
          className="font-medium text-gray-900"
          style={{
            fontSize: "clamp(1.75rem,7vw,4.2rem)",
            lineHeight: 1.08,
            letterSpacing: "-0.03em",
          }}
        >
          <span className="sm:hidden">
            <span className="italic font-light text-gray-500">Passive</span> compute on Base. Close your laptop and earn by dawn.
          </span>
          <span className="hidden sm:inline" style={{ fontSize: "clamp(2.5rem,5vw,4.2rem)" }}>
            <span className="italic font-light text-gray-500">Passive</span> compute on Base.
            <br />
            Close your laptop.
            <br />
            Earn by dawn.
          </span>
        </h1>

        <div className="mt-8 sm:mt-12 flex flex-col sm:flex-row gap-4 sm:gap-5 items-start sm:items-center">
          <Link
            to="/download"
            className="group bg-[#F29B8A] hover:bg-[#E07F73] text-gray-900 text-[13px] sm:text-[14px] font-medium rounded-full pl-5 sm:pl-6 pr-2 py-2 inline-flex items-center gap-3 transition-colors"
          >
            <span>Download agent</span>
            <span
              className="w-7 h-7 sm:w-8 sm:h-8 bg-gray-900 rounded-full flex items-center justify-center transition-transform duration-500 group-hover:-rotate-45"
              style={{ transitionTimingFunction: EASE }}
            >
              <ArrowRight size={14} className="text-[#F29B8A]" />
            </span>
          </Link>

          <div
            className="bg-white flex items-center gap-2 px-3 py-2 transition-shadow"
            style={{
              boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
              borderRadius: 4,
            }}
          >
            <BaseIcon className="w-5 h-5 sm:w-6 sm:h-6" />
            <span className="text-[13px] sm:text-[14px] font-medium text-gray-900">Settles on Base</span>
            <span className="text-[10px] sm:text-[11px] bg-gray-900 text-white px-1.5 sm:px-2 py-0.5 rounded">USDC</span>
          </div>
        </div>

        <div className="mt-4 sm:mt-5 inline-flex items-center gap-2 bg-white/80 backdrop-blur-sm rounded-full pl-3.5 pr-1.5 py-1 border border-gray-900/10 shadow-sm">
          <span className="text-[10px] uppercase tracking-[0.16em] text-gray-500">CA</span>
          <span className="text-[12px] font-mono text-gray-900">TBA</span>
        </div>
      </div>
    </section>
  );
}
