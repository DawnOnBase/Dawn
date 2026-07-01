import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Github,
  LifeBuoy,
  Loader2,
  Mail,
  MessageCircle,
  Send,
} from "lucide-react";
import SiteNav from "@/components/axion/SiteNav";
import Footer from "@/components/axion/Footer";

export const Route = createFileRoute("/support")({
  component: SupportPage,
  head: () => ({
    meta: [
      { title: "Support — Dawn" },
      {
        name: "description",
        content:
          "Get help with the Dawn agent, running an operator, submitting jobs, or USDC payouts. Reach the team — we usually reply within a day.",
      },
      { property: "og:title", content: "Support — Dawn" },
      {
        property: "og:description",
        content: "Questions about the Dawn agent, operators, jobs, or payouts? We're here to help.",
      },
    ],
  }),
});

const CATEGORIES = [
  "General question",
  "Running an operator",
  "Submitting jobs",
  "Payouts / USDC",
  "Bug report",
];

const CHANNELS = [
  { icon: Send, label: "Telegram", value: "@dawnonbase", href: "https://t.me/dawnonbase" },
  {
    icon: MessageCircle,
    label: "X / Twitter",
    value: "@dawnonbase",
    href: "https://x.com/dawnonbase",
  },
  { icon: Github, label: "GitHub", value: "DawnOnBase", href: "https://github.com/DawnOnBase" },
  { icon: Mail, label: "Email", value: "support@dawnonbase.com", href: "mailto:support@dawnonbase.com" },
];

const FAQS = [
  {
    q: "How do I start earning?",
    a: "Download the agent, fund the node address with a little Base ETH, and run it. It picks up jobs when idle and settles USDC to your address.",
  },
  {
    q: "When do payouts arrive?",
    a: "Each job self-settles on-chain the moment its proof is accepted — USDC lands in your node wallet, claimable any time.",
  },
  {
    q: "Is my machine safe?",
    a: "Jobs run in a WebAssembly sandbox with no access to your files or network outside the job scope. Userspace only, no root.",
  },
  {
    q: "Which chains are supported?",
    a: "Dawn settles on Base mainnet in USDC. The Settlement contract is public and verifiable on BaseScan.",
  },
];

const EMPTY = { name: "", email: "", category: CATEGORIES[0], message: "" };

function SupportPage() {
  const [form, setForm] = useState(EMPTY);
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [toast, setToast] = useState<{ seq: number; msg: string } | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === "sending") return;
    setStatus("sending");
    // Mockup: pretend to deliver the message, then confirm with a toast.
    window.setTimeout(() => {
      setStatus("sent");
      setToast((t) => ({
        seq: (t?.seq ?? 0) + 1,
        msg: `Thanks${form.name ? `, ${form.name.split(" ")[0]}` : ""} — we'll reply within a day.`,
      }));
      setForm(EMPTY);
      window.setTimeout(() => setStatus("idle"), 2400);
    }, 1300);
  }

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4800);
    return () => window.clearTimeout(t);
  }, [toast]);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <main className="min-h-screen bg-white">
      <div style={{ backgroundColor: "#EFEFEF" }}>
        <SiteNav variant="muted" />
      </div>

      <div className="mx-auto w-full max-w-[1440px] px-5 sm:px-8 lg:px-12 pb-20">
        {/* Hero */}
        <div className="relative overflow-hidden pt-10 sm:pt-16 lg:pt-24 pb-10 sm:pb-14">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-24 right-0 h-[440px] w-[440px] rounded-full opacity-50 blur-3xl"
            style={{
              background: "radial-gradient(circle, #F29B8A 0%, transparent 70%)",
              animation: "sp-float 9s ease-in-out infinite",
            }}
          />
          <div className="relative sp-rise">
            <div className="flex items-center gap-3 mb-5">
              <span className="w-2 h-2 rounded-full bg-[#F29B8A]" style={{ animation: "sp-pulse 2.4s ease-in-out infinite" }} />
              <span className="text-[11px] sm:text-[12px] uppercase tracking-[0.18em] text-gray-600">
                Support · usually replies within a day
              </span>
            </div>
            <h1
              className="font-medium text-gray-900 max-w-[16ch]"
              style={{ fontSize: "clamp(2rem,6vw,4.2rem)", lineHeight: 1.05, letterSpacing: "-0.035em" }}
            >
              How can we <span className="italic font-light text-gray-500">help</span>?
            </h1>
            <p className="mt-6 sm:mt-7 max-w-[54ch] text-[15px] sm:text-[17px] leading-[1.55] text-gray-600">
              Stuck installing the agent, running an operator, or wondering where a payout went?
              Send us a note — a real human on the Dawn team will get back to you.
            </p>
          </div>
        </div>

        {/* Form + sidebar */}
        <section className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-6">
          {/* Contact form */}
          <form
            onSubmit={onSubmit}
            className="relative bg-[#EFEFEF] rounded-2xl p-7 sm:p-9 sp-rise overflow-hidden"
            style={{ animationDelay: "0.08s" }}
          >
            <span className="absolute top-0 left-0 h-[3px] bg-[#F29B8A]" style={{ animation: "sp-bar 0.9s 0.3s both cubic-bezier(0.25,0.1,0.25,1)" }} />
            <div className="flex items-center gap-3 mb-6">
              <span className="w-2 h-2 rounded-full bg-[#F29B8A]" />
              <span className="text-[11px] uppercase tracking-[0.18em] text-gray-600">Send us a message</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="flex flex-col gap-2">
                <span className="text-[13px] font-medium text-gray-900">Name</span>
                <input
                  required
                  value={form.name}
                  onChange={set("name")}
                  placeholder="Satoshi"
                  className="bg-white rounded-xl px-4 py-3 text-[14px] text-gray-900 placeholder:text-gray-400 outline-none border border-transparent focus:border-[#F29B8A] transition-colors"
                />
              </label>
              <label className="flex flex-col gap-2">
                <span className="text-[13px] font-medium text-gray-900">Email</span>
                <input
                  required
                  type="email"
                  value={form.email}
                  onChange={set("email")}
                  placeholder="you@example.com"
                  className="bg-white rounded-xl px-4 py-3 text-[14px] text-gray-900 placeholder:text-gray-400 outline-none border border-transparent focus:border-[#F29B8A] transition-colors"
                />
              </label>
            </div>

            <label className="flex flex-col gap-2 mt-4">
              <span className="text-[13px] font-medium text-gray-900">Topic</span>
              <select
                value={form.category}
                onChange={set("category")}
                className="bg-white rounded-xl px-4 py-3 text-[14px] text-gray-900 outline-none border border-transparent focus:border-[#F29B8A] transition-colors appearance-none"
              >
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-2 mt-4">
              <span className="text-[13px] font-medium text-gray-900">Message</span>
              <textarea
                required
                value={form.message}
                onChange={set("message")}
                rows={5}
                placeholder="Tell us what's going on…"
                className="bg-white rounded-xl px-4 py-3 text-[14px] text-gray-900 placeholder:text-gray-400 outline-none border border-transparent focus:border-[#F29B8A] transition-colors resize-none"
              />
            </label>

            <button
              type="submit"
              disabled={status === "sending"}
              className={`group mt-6 inline-flex items-center justify-center gap-3 text-[13px] font-medium rounded-full pl-6 pr-2.5 py-2.5 self-start transition-colors ${
                status === "sent"
                  ? "bg-gray-900 text-white"
                  : "bg-[#F29B8A] hover:bg-[#E07F73] text-gray-900"
              } ${status === "sending" ? "opacity-80 cursor-wait" : ""}`}
            >
              <span>
                {status === "sending" ? "Sending…" : status === "sent" ? "Message sent" : "Send message"}
              </span>
              <span className="w-7 h-7 bg-gray-900 rounded-full flex items-center justify-center transition-transform duration-500 group-hover:-rotate-45">
                {status === "sending" ? (
                  <Loader2 size={13} className="text-[#F29B8A] animate-spin" />
                ) : status === "sent" ? (
                  <CheckCircle2 size={13} className="text-[#F29B8A]" />
                ) : (
                  <ArrowRight size={13} className="text-[#F29B8A]" />
                )}
              </span>
            </button>
          </form>

          {/* Sidebar */}
          <div className="flex flex-col gap-6">
            <div className="bg-gray-900 text-white rounded-2xl p-7 sp-rise" style={{ animationDelay: "0.16s" }}>
              <div className="flex items-center gap-3 mb-5">
                <span className="w-2 h-2 rounded-full bg-[#F29B8A]" />
                <span className="text-[11px] uppercase tracking-[0.18em] text-gray-400">Other ways to reach us</span>
              </div>
              <div className="flex flex-col">
                {CHANNELS.map(({ icon: Icon, label, value, href }) => (
                  <a
                    key={label}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-center gap-4 border-t border-white/10 py-4 first:border-0 first:pt-0 last:pb-0"
                  >
                    <span className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center shrink-0 group-hover:bg-[#F29B8A] transition-colors">
                      <Icon size={15} className="text-[#F29B8A] group-hover:text-gray-900 transition-colors" />
                    </span>
                    <span className="flex-1">
                      <span className="block text-[14px] font-medium">{label}</span>
                      <span className="block text-[13px] text-gray-400">{value}</span>
                    </span>
                    <ArrowRight size={14} className="text-gray-500 group-hover:text-white transition-all group-hover:translate-x-0.5" />
                  </a>
                ))}
              </div>
            </div>

            <div className="bg-[#EFEFEF] rounded-2xl p-7 sp-rise" style={{ animationDelay: "0.24s" }}>
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-70" style={{ animation: "sp-ping 1.8s cubic-bezier(0,0,0.2,1) infinite" }} />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
                </span>
                <span className="text-[13px] font-medium text-gray-900">All systems operational</span>
              </div>
              <div className="mt-4 flex items-center gap-3 text-[13px] text-gray-600">
                <LifeBuoy size={15} className="text-[#F29B8A]" />
                Typical response time: <span className="text-gray-900 font-medium">under a day</span>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="mt-20 sm:mt-28">
          <div className="flex items-center gap-3 mb-6">
            <span className="w-2 h-2 rounded-full bg-[#F29B8A]" />
            <span className="text-[11px] sm:text-[12px] uppercase tracking-[0.18em] text-gray-600">Before you write</span>
          </div>
          <h2
            className="font-medium text-gray-900 max-w-[20ch]"
            style={{ fontSize: "clamp(1.6rem,4vw,2.6rem)", lineHeight: 1.1, letterSpacing: "-0.025em" }}
          >
            Common questions.
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-5 mt-10">
            {FAQS.map((f, i) => (
              <div key={f.q} className="bg-[#EFEFEF] rounded-2xl p-6 sp-rise" style={{ animationDelay: `${0.1 + i * 0.06}s` }}>
                <div className="text-[16px] font-medium text-gray-900" style={{ letterSpacing: "-0.01em" }}>{f.q}</div>
                <p className="mt-2 text-[13px] leading-relaxed text-gray-600">{f.a}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      <Footer />

      {/* Toast (bottom-right) */}
      {toast && (
        <div key={toast.seq} className="fixed bottom-5 right-5 z-[100] max-w-[360px]" style={{ animation: "sp-toast-in 0.5s cubic-bezier(0.32,0.72,0,1)" }}>
          <div className="flex items-start gap-3 bg-gray-900 text-white rounded-2xl px-5 py-4 border border-white/10 shadow-2xl">
            <span className="w-8 h-8 rounded-full bg-[#F29B8A] flex items-center justify-center shrink-0">
              <CheckCircle2 size={16} className="text-gray-900" />
            </span>
            <div>
              <div className="text-[14px] font-medium">Message sent</div>
              <div className="text-[13px] text-gray-400 mt-0.5">{toast.msg}</div>
            </div>
          </div>
          <div className="mt-1 h-[2px] bg-[#F29B8A]/70 rounded-full origin-left" style={{ animation: "sp-toast-bar 4.8s linear forwards" }} />
        </div>
      )}

      <style>{`
        .sp-rise { animation: sp-rise 0.7s cubic-bezier(0.25,0.1,0.25,1) both; }
        @keyframes sp-rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes sp-float { 0%,100% { transform: translateY(0) scale(1); } 50% { transform: translateY(24px) scale(1.06); } }
        @keyframes sp-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        @keyframes sp-bar { from { width: 0; } to { width: 64px; } }
        @keyframes sp-ping { 75%,100% { transform: scale(2.2); opacity: 0; } }
        @keyframes sp-toast-in { from { opacity: 0; transform: translate(24px, 24px); } to { opacity: 1; transform: translate(0,0); } }
        @keyframes sp-toast-bar { from { transform: scaleX(1); } to { transform: scaleX(0); } }
        @media (prefers-reduced-motion: reduce) {
          .sp-rise { animation: none; }
        }
      `}</style>
    </main>
  );
}
