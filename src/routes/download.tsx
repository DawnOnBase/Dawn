import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Apple,
  CheckCircle2,
  Cpu,
  HardDrive,
  Lock,
  Moon,
  ShieldCheck,
  Terminal,
  Wallet,
  Zap,
} from "lucide-react";
import SiteNav from "@/components/axion/SiteNav";
import Footer from "@/components/axion/Footer";

export const Route = createFileRoute("/download")({
  component: DownloadPage,
  head: () => ({
    meta: [
      { title: "Download the Dawn Agent — Earn USDC from idle compute" },
      {
        name: "description",
        content:
          "Download the Dawn Agent for macOS, Windows, or Linux. Install, connect your Base wallet, and earn USDC while your machine is idle.",
      },
      { property: "og:title", content: "Download the Dawn Agent — Earn USDC from idle compute" },
      {
        property: "og:description",
        content:
          "A lightweight desktop agent that turns your idle laptop into a Base-settled compute node. No CLI, no Docker, no configuration.",
      },
    ],
  }),
});

type Os = "macOS" | "Windows" | "Linux";

const DOWNLOAD_BASE = "https://api.dawnonbase.com/downloads";

type Platform = {
  os: Os;
  detail: string;
  sub: string;
  file: string;
  href: string;
  available: boolean;
  icon: typeof Apple;
};

const ALL_PLATFORMS: Platform[] = [
  {
    os: "macOS",
    detail: "Universal · ~8 MB · CLI",
    sub: "macOS 12 Monterey or newer · Apple Silicon & Intel",
    file: "dawn-agent-macos-universal.tar.gz",
    href: `${DOWNLOAD_BASE}/dawn-agent-macos-universal.tar.gz`,
    available: true,
    icon: Apple,
  },
  {
    os: "Windows",
    detail: "x64 · CLI",
    sub: "Windows 10 / 11 · 64-bit",
    file: "dawn-agent-windows-x64.zip",
    href: `${DOWNLOAD_BASE}/dawn-agent-windows-x64.zip`,
    available: true,
    icon: HardDrive,
  },
  {
    os: "Linux",
    detail: "x64 · CLI",
    sub: "Ubuntu 20.04+ · Debian 11+ · Fedora 38+",
    file: "dawn-agent-linux-x64.tar.gz",
    href: `${DOWNLOAD_BASE}/dawn-agent-linux-x64.tar.gz`,
    available: true,
    icon: Terminal,
  },
];


function getDetectedOs(): Os {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "macOS";
  const ua = navigator.userAgent.toLowerCase();
  const platform = navigator.platform?.toLowerCase() ?? "";
  if (ua.includes("win") || platform.includes("win")) return "Windows";
  if (ua.includes("mac") || platform.includes("mac")) return "macOS";
  if (ua.includes("linux") || platform.includes("linux")) return "Linux";
  return "macOS";
}

const STEPS = [
  {
    n: "01",
    title: "Download the agent",
    body: "Grab the build for your OS above and unpack it. It's an early-access CLI — the bundled README has the one-line run command.",
  },
  {
    n: "02",
    title: "Connect your Base wallet",
    body: "Open the app and paste a Base address (or generate one in-app). All payouts settle in USDC to this wallet.",
  },
  {
    n: "03",
    title: "Set your idle preferences",
    body: "Battery threshold, thermal limits, on/off schedule. Defaults are safe — the agent only runs when you're not.",
  },
  {
    n: "04",
    title: "Close your laptop",
    body: "Dawn picks up micro-jobs while you're away and yields the moment you return. Earnings claimable any time.",
  },
];

const REQS = [
  { icon: Cpu, label: "CPU", value: "Any 64-bit · GPU optional but boosts payout" },
  { icon: HardDrive, label: "Storage", value: "200 MB free for the agent + job sandbox" },
  { icon: Zap, label: "Network", value: "5 Mbps down / 1 Mbps up minimum" },
  { icon: Wallet, label: "Wallet", value: "Any Base address — Coinbase Wallet, Rainbow, MetaMask" },
];

const TRUST = [
  {
    icon: ShieldCheck,
    title: "Sandboxed execution",
    body: "Jobs run in a WebAssembly sandbox — no access to your files, browser, or network outside the job scope.",
  },
  {
    icon: Lock,
    title: "Userspace only",
    body: "No kernel extensions, no root, no system modifications. Uninstall removes everything.",
  },
  {
    icon: Moon,
    title: "Truly idle-only",
    body: "Runs when your screen is off, lid is closed, or you're inactive. Yields instantly the moment you touch your machine.",
  },
];

function DownloadPage() {
  const [detectedOs, setDetectedOs] = useState<Os>("macOS");

  useEffect(() => {
    setDetectedOs(getDetectedOs());
  }, []);

  const platforms = useMemo(() => {
    const match = ALL_PLATFORMS.find((p) => p.os === detectedOs);
    const rest = ALL_PLATFORMS.filter((p) => p.os !== detectedOs);
    return match ? [match, ...rest] : ALL_PLATFORMS;
  }, [detectedOs]);

  return (
    <main className="min-h-screen bg-white">
      <div style={{ backgroundColor: "#EFEFEF" }}>
        <SiteNav variant="muted" />
      </div>

      <div className="mx-auto w-full max-w-[1440px] px-5 sm:px-8 lg:px-12 pb-20">
        {/* Hero */}
        <div className="pt-10 sm:pt-16 lg:pt-24 pb-10 sm:pb-14">
          <div className="flex items-center gap-3 mb-5">
            <span className="w-2 h-2 rounded-full bg-[#F29B8A]" />
            <span className="text-[11px] sm:text-[12px] uppercase tracking-[0.18em] text-gray-600">
              Dawn Agent · early access · CLI
            </span>
          </div>
          <h1
            className="font-medium text-gray-900 max-w-[22ch]"
            style={{
              fontSize: "clamp(2rem,6vw,4.2rem)",
              lineHeight: 1.05,
              letterSpacing: "-0.035em",
            }}
          >
            Download Dawn. Earn while your laptop{" "}
            <span className="italic font-light text-gray-500">sleeps</span>.
          </h1>
          <p className="mt-6 sm:mt-7 max-w-[58ch] text-[15px] sm:text-[17px] leading-[1.55] text-gray-600">
            A 14 MB native agent. Detects when your machine is idle, runs sandboxed
            micro-jobs, and settles payouts in USDC on Base. Yields instantly when
            you come back.
          </p>
        </div>

        {/* Platform cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-5">
          {platforms.map(({ os, detail, sub, file, href, available, icon: Icon }) => {
            const primary = os === detectedOs;
            return (
              <div
                key={os}
                className={`rounded-2xl p-6 sm:p-7 flex flex-col gap-5 border-b-[3px] ${
                  primary
                    ? "bg-gray-900 text-white border-[#F29B8A]"
                    : "bg-[#EFEFEF] text-gray-900 border-gray-900"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div
                    className={`w-11 h-11 rounded-full flex items-center justify-center ${
                      primary ? "bg-white/10" : "bg-white"
                    }`}
                  >
                    <Icon size={18} className={primary ? "text-[#F29B8A]" : "text-gray-900"} />
                  </div>
                  {primary && (
                    <span className="text-[10px] uppercase tracking-wider bg-[#F29B8A] text-gray-900 px-2 py-1 rounded-full font-medium">
                      Recommended for you
                    </span>
                  )}
                </div>

                <div>
                  <div className="text-[22px] font-medium" style={{ letterSpacing: "-0.02em" }}>
                    {os}
                  </div>
                  <div className={`text-[12px] mt-1 ${primary ? "text-gray-400" : "text-gray-600"}`}>
                    {detail}
                  </div>
                </div>

                <p className={`text-[13px] leading-relaxed ${primary ? "text-gray-400" : "text-gray-600"}`}>
                  {sub}
                </p>

                {available ? (
                  <a
                    href={href}
                    download
                    className={`group mt-auto text-[13px] font-medium rounded-full pl-5 pr-2 py-2 inline-flex items-center justify-between gap-3 self-stretch ${
                      primary ? "bg-[#F29B8A] text-gray-900" : "bg-gray-900 text-white"
                    }`}
                  >
                    <span>Download</span>
                    <span
                      className={`w-7 h-7 rounded-full flex items-center justify-center transition-transform duration-500 group-hover:-rotate-45 ${
                        primary ? "bg-gray-900" : "bg-white"
                      }`}
                    >
                      <ArrowRight size={12} className={primary ? "text-[#F29B8A]" : "text-gray-900"} />
                    </span>
                  </a>
                ) : (
                  <button
                    disabled
                    className={`group mt-auto text-[13px] font-medium rounded-full pl-5 pr-2 py-2 inline-flex items-center justify-between gap-3 self-stretch cursor-not-allowed opacity-80 ${
                      primary ? "bg-[#F29B8A]/60 text-gray-900" : "bg-gray-900/70 text-white"
                    }`}
                  >
                    <span>Building…</span>
                    <span
                      className={`w-7 h-7 rounded-full flex items-center justify-center ${
                        primary ? "bg-gray-900" : "bg-white"
                      }`}
                    >
                      <ArrowRight size={12} className={primary ? "text-[#F29B8A]" : "text-gray-900"} />
                    </span>
                  </button>
                )}

                <div className={`text-[11px] font-mono ${primary ? "text-gray-500" : "text-gray-500"}`}>
                  {file}
                </div>
              </div>
            );
          })}
        </div>

        {/* Checksums / signed note */}
        <div className="mt-5 flex items-center gap-2 text-[12px] text-gray-500">
          <ShieldCheck size={13} className="text-[#F29B8A]" />
          Early-access CLI build (unsigned) — live and settling on Base mainnet now. Signed installers coming.
        </div>

        {/* Steps */}
        <section className="mt-20 sm:mt-28">
          <div className="flex items-center gap-3 mb-6">
            <span className="w-2 h-2 rounded-full bg-[#F29B8A]" />
            <span className="text-[11px] sm:text-[12px] uppercase tracking-[0.18em] text-gray-600">
              Setup · under 2 minutes
            </span>
          </div>
          <h2
            className="font-medium text-gray-900 max-w-[20ch]"
            style={{ fontSize: "clamp(1.6rem,4vw,2.8rem)", lineHeight: 1.1, letterSpacing: "-0.025em" }}
          >
            From install to <span className="italic font-light text-gray-500">earning</span>.
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5 mt-10">
            {STEPS.map((s) => (
              <div key={s.n} className="bg-[#EFEFEF] rounded-2xl p-6 flex flex-col gap-3">
                <span className="text-[11px] font-mono text-[#F29B8A] tracking-wider">{s.n}</span>
                <div className="text-[17px] font-medium text-gray-900" style={{ letterSpacing: "-0.01em" }}>
                  {s.title}
                </div>
                <p className="text-[13px] leading-relaxed text-gray-600">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Requirements */}
        <section className="mt-20 sm:mt-28 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-[#EFEFEF] rounded-2xl p-7 sm:p-9">
            <div className="flex items-center gap-3 mb-5">
              <span className="w-2 h-2 rounded-full bg-[#F29B8A]" />
              <span className="text-[11px] uppercase tracking-[0.18em] text-gray-600">
                System requirements
              </span>
            </div>
            <h3 className="text-[22px] sm:text-[26px] font-medium text-gray-900 mb-6" style={{ letterSpacing: "-0.02em" }}>
              Runs on almost anything.
            </h3>
            <div className="flex flex-col gap-4">
              {REQS.map(({ icon: Icon, label, value }) => (
                <div key={label} className="flex items-start gap-4 border-t border-gray-300 pt-4 first:border-0 first:pt-0">
                  <div className="w-9 h-9 rounded-full bg-white flex items-center justify-center shrink-0">
                    <Icon size={14} className="text-gray-900" />
                  </div>
                  <div className="flex-1">
                    <div className="text-[13px] font-medium text-gray-900">{label}</div>
                    <div className="text-[13px] text-gray-600">{value}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-gray-900 text-white rounded-2xl p-7 sm:p-9">
            <div className="flex items-center gap-3 mb-5">
              <span className="w-2 h-2 rounded-full bg-[#F29B8A]" />
              <span className="text-[11px] uppercase tracking-[0.18em] text-gray-400">
                Safety & privacy
              </span>
            </div>
            <h3 className="text-[22px] sm:text-[26px] font-medium mb-6" style={{ letterSpacing: "-0.02em" }}>
              Your machine. Your rules.
            </h3>
            <div className="flex flex-col gap-5">
              {TRUST.map(({ icon: Icon, title, body }) => (
                <div key={title} className="flex items-start gap-4 border-t border-white/10 pt-5 first:border-0 first:pt-0">
                  <Icon size={16} className="text-[#F29B8A] mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="text-[14px] font-medium">{title}</div>
                    <div className="text-[13px] text-gray-400 mt-1 leading-relaxed">{body}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Build with the SDK */}
        <section className="mt-20 sm:mt-28">
          <div className="rounded-3xl bg-gray-900 text-white p-8 sm:p-12 lg:p-16 flex flex-col lg:flex-row gap-10 lg:gap-16 items-start">
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-5">
                <span className="w-2 h-2 rounded-full bg-[#F29B8A]" />
                <span className="text-[11px] uppercase tracking-[0.18em] text-gray-400">
                  For developers
                </span>
              </div>
              <h3 className="font-medium" style={{ fontSize: "clamp(1.6rem,3.5vw,2.4rem)", letterSpacing: "-0.025em", lineHeight: 1.1 }}>
                Submitting jobs instead of running them?
              </h3>
              <p className="mt-5 text-[14px] sm:text-[15px] text-gray-400 leading-relaxed max-w-[52ch]">
                Skip the desktop app. Use the Dawn SDK to push jobs onto the network
                from your backend — AI inference, rendering, ETL, anything you can
                compile to WebAssembly. Pay per job in USDC.
              </p>
              <a
                href="https://github.com/DawnOnBase/SDK"
                target="_blank"
                rel="noopener noreferrer"
                className="group mt-7 inline-flex items-center gap-3 bg-[#F29B8A] hover:bg-[#E07F73] text-gray-900 text-[13px] font-medium rounded-full pl-5 pr-2 py-2 transition-colors"
              >
                View the SDK on GitHub
                <span className="w-7 h-7 bg-gray-900 rounded-full flex items-center justify-center transition-transform duration-500 group-hover:-rotate-45">
                  <ArrowRight size={12} className="text-[#F29B8A]" />
                </span>
              </a>
            </div>

            <div className="w-full lg:w-[420px] bg-black/40 rounded-2xl p-5 border border-white/10 font-mono text-[12px] leading-relaxed text-gray-300">
              <div className="flex items-center gap-2 mb-3 text-gray-500">
                <span className="w-2 h-2 rounded-full bg-[#F29B8A]" />
                submit-job.ts
              </div>
              <pre className="whitespace-pre-wrap">{`import { Dawn } from "@dawn/sdk";

const dawn = new Dawn({ wallet });

const job = await dawn.jobs.submit({
  type: "inference",
  model: "llama-3.1-8b",
  input: prompt,
  maxPayout: "0.002", // USDC
});

const result = await job.wait();`}</pre>
            </div>
          </div>
        </section>

        {/* What's included */}
        <section className="mt-20 sm:mt-28">
          <div className="flex items-center gap-3 mb-6">
            <span className="w-2 h-2 rounded-full bg-[#F29B8A]" />
            <span className="text-[11px] uppercase tracking-[0.18em] text-gray-600">
              In the box
            </span>
          </div>
          <h2
            className="font-medium text-gray-900 max-w-[20ch]"
            style={{ fontSize: "clamp(1.6rem,4vw,2.4rem)", lineHeight: 1.1, letterSpacing: "-0.025em" }}
          >
            One install. Everything you need.
          </h2>

          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-3">
            {[
              "Idle detector — screen, lid, input, battery, thermals",
              "Sandboxed job runner — WebAssembly isolation, no host access",
              "Built-in Base wallet (or bring your own)",
              "Automatic USDC payouts, claimable any time",
              "Proof-of-execution engine with on-chain attestations",
              "Earnings dashboard inside the agent",
              "Per-job logs and resource usage breakdown",
              "Auto-updates with signed release channels",
            ].map((item) => (
              <div key={item} className="flex items-start gap-3 border-b border-gray-200 py-3">
                <CheckCircle2 size={15} className="text-[#F29B8A] mt-0.5 shrink-0" />
                <span className="text-[14px] text-gray-800">{item}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <Footer />
    </main>
  );
}
