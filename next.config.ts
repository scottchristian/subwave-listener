import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
        ],
      },

      // Never let a browser revalidate a document into an empty one.
      //
      // The player is a client component: it fetches its lineup, session and
      // everything else at runtime, so the HTML document is an 8KB shell that
      // caching buys nothing for. Worse, Next prerenders it and answers with an
      // ETag, which made a reload a *revalidation* rather than a refetch:
      //
      //   "GET / HTTP/2.0"  304  0   <- no body, by design
      //
      // A 304 carries no body on purpose — the client is meant to reuse what it
      // cached. A hard reload can drop that stored body while keeping the
      // validator, and then the browser is left with a valid cache entry and no
      // content to render: "This page couldn't load", reproducibly, only in
      // browsers that had visited before, and never in a private window. Every
      // subresource still fetched fine, which is what made it look like the
      // network was at fault.
      //
      // So documents are no-store and must revalidate, which also stops a
      // returning listener booting last week's build. Hashed assets below keep
      // their long life — those are safe, because the filename changes whenever
      // the bytes do.
      {
        source: '/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, max-age=0' },
        ],
      },

      // ...except the content-addressed bundles, where a year is correct.
      {
        source: '/_next/static/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ];
  },
};

export default nextConfig;
