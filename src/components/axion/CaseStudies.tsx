import { Globe, Wallet, Zap, Link2, Cpu, ChevronRight } from "lucide-react";

const PARTNERS = [
  {
    icon: Globe,
    name: "Base",
    description: "Native L2 settlement. Sub-cent USDC payouts make micro-jobs economically viable on Base.",
  },
  {
    icon: Wallet,
    name: "USDC",
    description: "Earnings settle in stablecoins. Claim anytime, no volatility, no lockups.",
  },
  {
    icon: Link2,
    name: "x402",
    description: "Agent-native payments. AI agents submit jobs with payment in a single HTTP request.",
  },
  {
    icon: Cpu,
    name: "Wasmtime",
    description: "Sandboxed job execution. Every task runs in a WebAssembly sandbox destroyed after completion.",
  },
  {
    icon: Link2,
    name: "EIP-712",
    description: "On-chain proof-of-execution. Every job settles against a signed EIP-712 attestation the contract verifies.",
  },
  {
    icon: Zap,
    name: "SDK",
    description: "A TypeScript SDK for submitting jobs and polling results — pay per job in USDC.",
  },
];

export default function CaseStudies() {
  return (
    <section className="bg-[#F5F5F5] pt-16 sm:pt-20 lg:pt-28 pb-16 sm:pb-20 lg:pb-28">
      <div className="mx-auto max-w-[1440px]">
        <div className="px-5 sm:px-8 lg:px-12 flex items-center gap-3 mb-6 sm:mb-8">
          <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-gray-900 text-white text-[11px] sm:text-[12px] font-semibold flex items-center justify-center">
            2
          </div>
          <span className="text-[12px] sm:text-[13px] font-medium border border-gray-300 rounded-full px-3 sm:px-4 py-1 sm:py-1.5">
            Stack
          </span>
        </div>

        <h2
          className="px-5 sm:px-8 lg:px-12 font-medium text-gray-900 mb-10 sm:mb-14 lg:mb-16"
          style={{
            fontSize: "clamp(1.75rem,7vw,4.2rem)",
            lineHeight: 1.08,
            letterSpacing: "-0.03em",
          }}
        >
          <span className="sm:hidden">Built on Base, backed by the best.</span>
          <span className="hidden sm:inline" style={{ fontSize: "clamp(2.25rem,4.5vw,3.6rem)" }}>
            Built on Base,
            <br />
            backed by the best.
          </span>
        </h2>

        <div className="px-5 sm:px-8 lg:px-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6 lg:gap-7">
          {PARTNERS.map(({ icon: Icon, name, description }) => (
            <div
              key={name}
              className="group flex flex-col gap-5 rounded-2xl bg-white p-6 sm:p-7 transition-colors duration-500 hover:bg-[#F29B8A] border-b-[3px] border-[#F29B8A]"
              style={{ transitionTimingFunction: "cubic-bezier(0.25,0.1,0.25,1)" }}
            >
              <div className="flex items-center justify-between">
                <div className="w-10 h-10 rounded-full bg-[#F5F5F5] flex items-center justify-center transition-colors duration-500 group-hover:bg-gray-900">
                  <Icon size={18} className="text-gray-900 transition-colors duration-500 group-hover:text-[#F29B8A]" />
                </div>
                <ChevronRight
                  size={16}
                  className="text-gray-400 transition-transform duration-500 group-hover:translate-x-0.5 group-hover:text-gray-900"
                />
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="text-[18px] sm:text-[20px] font-medium text-gray-900" style={{ letterSpacing: "-0.01em" }}>
                  {name}
                </h3>
                <p className="text-[13px] sm:text-[14px] text-gray-600 leading-relaxed group-hover:text-gray-900 transition-colors duration-500">
                  {description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
