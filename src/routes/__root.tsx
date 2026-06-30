import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import appCss from "../styles.css?url";

// Canonical origin used to build ABSOLUTE og:image / og:url values — social
// crawlers (X, Telegram, Discord, iMessage, Slack…) reject relative image URLs.
// Resolved from the live request host so it's correct on the vercel.app URL AND
// the production domain. Falls back to the brand domain when no request exists.
const FALLBACK_ORIGIN = "https://dawnonbase.com";

async function resolveSiteInfo(): Promise<{ origin: string; href: string }> {
  if (import.meta.env.SSR) {
    try {
      // Dynamic + SSR-guarded so this server-only module is tree-shaken out of
      // the client bundle (import.meta.env.SSR is statically false there).
      const { getRequestUrl, getRequestHeader } = await import("@tanstack/react-start/server");
      const u = new URL(getRequestUrl());
      // Behind Vercel's proxy the public host/proto live in x-forwarded-*;
      // prefer them, fall back to the request URL's own host/proto.
      const fwdHost = getRequestHeader("x-forwarded-host")?.split(",")[0].trim();
      const fwdProto = getRequestHeader("x-forwarded-proto")?.split(",")[0].trim();
      const host = fwdHost || u.host;
      const proto = fwdProto || u.protocol.replace(":", "");
      const origin = `${proto}://${host}`;
      return { origin, href: origin + u.pathname };
    } catch {
      return { origin: FALLBACK_ORIGIN, href: `${FALLBACK_ORIGIN}/` };
    }
  }
  if (typeof window !== "undefined") {
    return {
      origin: window.location.origin,
      href: window.location.origin + window.location.pathname,
    };
  }
  return { origin: FALLBACK_ORIGIN, href: `${FALLBACK_ORIGIN}/` };
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  loader: async () => resolveSiteInfo(),
  head: ({ loaderData }) => {
    const origin = loaderData?.origin ?? FALLBACK_ORIGIN;
    const href = loaderData?.href ?? `${FALLBACK_ORIGIN}/`;
    const ogImage = `${origin}/og-image.jpg`;
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: "Dawn — Passive compute network on Base" },
        { name: "description", content: "Dawn is a passive compute network on Base. Earn USDC by letting your idle laptop run micro-jobs. No CLI. No Docker. Just install and forget." },
        { property: "og:title", content: "Dawn — Passive compute network on Base" },
        { property: "og:description", content: "Earn USDC by letting your idle laptop run micro-jobs. Close your laptop. Get paid by dawn." },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: "Dawn" },
        { property: "og:url", content: href },
        { property: "og:image", content: ogImage },
        { property: "og:image:width", content: "1536" },
        { property: "og:image:height", content: "1024" },
        { property: "og:image:alt", content: "Dawn — Passive compute network on Base" },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: "Dawn" },
        { name: "twitter:description", content: "Earn USDC by letting your idle laptop run micro-jobs. Close your laptop. Get paid by dawn." },
        { name: "twitter:image", content: ogImage },
      ],
      links: [
        {
          rel: "stylesheet",
          href: appCss,
        },
        { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
      ],
    };
  },
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  );
}
