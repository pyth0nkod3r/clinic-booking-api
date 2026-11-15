import {
  isRouteErrorResponse,
  Link,
  NavLink,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gradient-to-br from-cyan-900 via-cyan-700 to-teal-600 text-white">
        <div className="mx-auto max-w-5xl px-4 py-6">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <h1 className="text-xl font-semibold tracking-tight">
              🩺 Brightcare Clinic
            </h1>
            <nav className="flex gap-2 text-sm">
              {[
                { to: "/", label: "Book a slot" },
                { to: "/my-bookings", label: "My bookings" },
              ].map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    `rounded-full px-4 py-1.5 font-medium transition ${
                      isActive
                        ? "bg-white text-cyan-900"
                        : "text-cyan-50 hover:bg-white/15"
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <p className="mt-1 text-sm text-cyan-100/90">
            Pick a time, book it in seconds, get your confirmation instantly.
          </p>
        </div>
      </header>
      <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-8">
        <Outlet />
      </main>
      <footer className="text-center text-xs text-gray-400 pb-8">
        Brightcare Clinic demo · built for the Koya Cohort 4 assessment ·{" "}
        <Link
          to="https://clinic-booking-docs.onrender.com"
          className="underline hover:text-cyan-700"
          target="_blank"
        >
          API docs
        </Link>
      </footer>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
