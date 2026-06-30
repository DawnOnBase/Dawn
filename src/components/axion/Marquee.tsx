const ITEMS = [
  "Live on Base Sepolia testnet",
  "EIP-712 proof-of-execution",
  "WebAssembly job sandbox",
  "x402 USDC micropayments",
  "USDC settlement on Base",
  "Open marketplace · open code",
];

export default function Marquee() {
  const loop = [...ITEMS, ...ITEMS];
  return (
    <section className="bg-gray-900 text-white py-5 sm:py-6 overflow-hidden border-y border-white/5">
      <div
        className="flex gap-12 sm:gap-16 whitespace-nowrap"
        style={{ animation: "marquee 38s linear infinite", width: "max-content" }}
      >
        {loop.map((t, i) => (
          <span key={i} className="flex items-center gap-12 sm:gap-16 text-[14px] sm:text-[16px] font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-[#F29B8A] shrink-0" />
            <span className="tracking-[-0.01em]">{t}</span>
          </span>
        ))}
      </div>
      <style>{`@keyframes marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }`}</style>
    </section>
  );
}