
const STATS = [
  { value: "14–18", label: "Idle hours per laptop daily" },
  { value: "<2s", label: "Median settlement on Base" },
  { value: "0.5%", label: "Protocol fee per job" },
  { value: "99.98%", label: "Target sandbox uptime" },
];

export default function About() {
  return (
    <section className="bg-white pt-16 sm:pt-20 lg:pt-32 pb-16 sm:pb-20 lg:pb-32 overflow-hidden">
      <div className="mx-auto max-w-[1440px]">
        <div className="px-5 sm:px-8 lg:px-12 flex items-center gap-3 mb-6 sm:mb-8">
          <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-gray-900 text-white text-[11px] sm:text-[12px] font-semibold flex items-center justify-center">
            1
          </div>
          <span className="text-[12px] sm:text-[13px] font-medium border border-gray-200 rounded-full px-3 sm:px-4 py-1 sm:py-1.5">
            Introducing Dawn
          </span>
        </div>

        <h2
          className="px-5 sm:px-8 lg:px-12 font-medium text-gray-900 mb-12 sm:mb-16 lg:mb-20"
          style={{
            fontSize: "clamp(1.75rem,5vw,3.8rem)",
            lineHeight: 1.12,
            letterSpacing: "-0.03em",
          }}
        >
          A marketplace for idle compute,{" "}
          <br />
          powered by the world's{" "}
          <span className="italic font-light text-gray-500">sleeping</span> devices.
        </h2>

        <div className="px-5 sm:px-8 lg:px-12 grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 mb-14 sm:mb-20">
          <div className="lg:col-span-7 flex flex-col gap-8">
            <p className="text-[17px] sm:text-[19px] lg:text-[22px] leading-[1.5] font-medium text-gray-900 max-w-[46ch]">
              Dawn bridges idle consumer hardware to compute demand through a single desktop application. No CLI. No Docker. No configuration. Install and forget.
            </p>
          </div>
          <div className="lg:col-span-5 flex flex-col gap-5 lg:pt-2">
            {[
              "Download the Dawn Agent for macOS, Windows, or Linux",
              "Connect a Base wallet and set idle preferences",
              "Earn USDC while your machine sleeps",
            ].map((item) => (
              <div key={item} className="flex items-start gap-4 border-t border-gray-200 pt-5">
                <span className="mt-2 w-1.5 h-1.5 rounded-full bg-[#F29B8A] shrink-0" />
                <p className="text-[14px] sm:text-[15px] leading-[1.55] text-gray-700">{item}</p>
              </div>
            ))}
          </div>
        </div>

      </div>
    </section>
  );
}
