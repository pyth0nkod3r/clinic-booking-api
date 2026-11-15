import type { Config } from "@react-router/dev/config";

export default {
  // SPA mode: static bundle on Render; the API lives on a separate origin.
  ssr: false,
  // Pre-render both routes to real HTML files so deep links (/my-bookings)
  // work on static hosting without server rewrite rules.
  prerender: ["/", "/my-bookings"],
} satisfies Config;
