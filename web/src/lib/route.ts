import { useEffect, useState } from "react";

export type RouteId = "live" | "approvals" | "lab" | "policies" | "reconciliation";
export const ROUTES: RouteId[] = ["live", "approvals", "lab", "policies", "reconciliation"];

const parse = (): RouteId => {
  const h = window.location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] ?? "";
  return (ROUTES as string[]).includes(h) ? (h as RouteId) : "live";
};

/** Hash routing keeps the production build a plain static site that the Fastify server can serve from /. */
export function useRoute(): RouteId {
  const [r, setR] = useState<RouteId>(parse);
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

export const navigate = (r: RouteId) => {
  window.location.hash = `/${r}`;
};
