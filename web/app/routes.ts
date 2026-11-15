import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("my-bookings", "routes/my-bookings.tsx"),
] satisfies RouteConfig;
