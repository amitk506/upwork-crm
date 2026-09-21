import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone with only the files the server needs, so the
  // runtime image does not carry node_modules or build tooling.
  output: 'standalone',

  async headers() {
    return [
      {
        // Every route, including API responses and redirects a crawler might
        // follow without ever parsing HTML — which is why this is not left to
        // the meta tag alone.
        source: '/:path*',
        headers: [
          {
            key: 'X-Robots-Tag',
            value: 'noindex, nofollow, noarchive, nosnippet, noimageindex',
          },
          // Keep the portal out of other people's referrer logs, and out of
          // frames entirely.
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ]
  },
  /* config options here */
};

export default nextConfig;
