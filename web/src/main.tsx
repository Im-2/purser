import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

/**
 * "/" is the public landing page and "/app" is the dashboard. They are separate chunks, so a visitor to the landing page never
 * downloads the dashboard (AG Grid and all), and the dashboard never downloads the landing page.
 */
const isDashboard = window.location.pathname === "/app" || window.location.pathname.startsWith("/app/");

async function boot() {
  const root = createRoot(document.getElementById("root")!);
  if (isDashboard) {
    const { App } = await import("./App");
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } else {
    const { default: Landing } = await import("./landing/Landing");
    root.render(
      <StrictMode>
        <Landing />
      </StrictMode>,
    );
  }
}
void boot();
