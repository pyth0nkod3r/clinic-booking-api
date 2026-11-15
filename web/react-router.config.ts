import type { Config } from "@react-router/dev/config";

export default {
  // Config options...
  // Server-side render by default, to enable SPA mode set this to `false`
  ssr: false, // SPA mode: static bundle on Render; the API lives on a separate origin
} satisfies Config;
