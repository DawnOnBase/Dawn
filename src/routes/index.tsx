import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { scrollToInitialHash } from "@/lib/scroll";
import Hero from "@/components/axion/Hero";
import About from "@/components/axion/About";
import CaseStudies from "@/components/axion/CaseStudies";
import ValueProps from "@/components/axion/ValueProps";
import HowItWorks from "@/components/axion/HowItWorks";
import CTA from "@/components/axion/CTA";
import Footer from "@/components/axion/Footer";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "Dawn — Passive compute network on Base" },
      { name: "description", content: "Dawn is a passive compute network on Base. Earn USDC by letting your idle laptop run micro-jobs. Close your laptop. Get paid by dawn." },
    ],
  }),
});

function Index() {
  useEffect(() => {
    scrollToInitialHash();
  }, []);
  return (
    <main>
      <Hero />
      <div id="about"><About /></div>
      <div id="marketplace"><CaseStudies /></div>
      <ValueProps />
      <div id="legion"><HowItWorks /></div>
      <div id="command-center"><CTA /></div>
      <Footer />
    </main>
  );
}
