import type { MetadataRoute } from 'next'

/**
 * Nothing here is for the public.
 *
 * This is an internal operations portal behind a login — it has no business in
 * a search index, and a smaller discovery surface is worth having on a host
 * that has already attracted an automated phishing classifier.
 *
 * robots.txt only asks well-behaved crawlers to stay away. The X-Robots-Tag
 * header in next.config.ts and the meta tag in the root layout are what
 * actually keep a page out of an index if it is reached anyway.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      disallow: '/',
    },
  }
}
