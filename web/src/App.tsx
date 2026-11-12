import { useCallback, useEffect, useState } from "react";
import { DrawerProvider } from "./components/AttemptDrawer";
import { FrozenBanner } from "./components/FrozenBanner";
import { Header, Rail } from "./components/Header";
import { Backdrop } from "./components/Backdrop";
import { HowItWorks } from "./components/HowItWorks";
import { UNAUTHORIZED_EVENT, clearToken, getToken, isDemo, setLoginNotice } from "./lib/api";
import { useRoute } from "./lib/route";
import { StoreProvider, useStore } from "./lib/store";
import { ToastProvider } from "./lib/toast";
import { ApprovalsPage } from "./pages/Approvals";
import { AttackLabPage } from "./pages/AttackLab";
import { PoliciesPage } from "./pages/Policies";
import { ReconciliationPage } from "./pages/Reconciliation";
import { LivePage } from "./pages/Live";
import { LoginPage } from "./pages/Login";

const PAGE_TITLE = { live: "Live decisions", approvals: "Approvals", lab: "Attack Lab", policies: "Policies", reconciliation: "Reconciliation" } as const;

function LoadError() {
  const { state, refreshAll } = useStore();
  const failed = Boolean(state.loadError);
  // the free instance may be waking up (or restarted): keep trying quietly until it answers
  useEffect(() => {
    if (!failed) return;
    const t = setInterval(() => void refreshAll(), 4000);
    return () => clearInterval(t);
  }, [failed, refreshAll]);
  if (!state.loadError) return null;
  return (
    <div role="alert" className="mx-4 mt-3 rounded-full border border-escalate-line bg-escalate-soft px-6 py-2.5 text-center text-[13px] text-escalate">
      Waking up or reconnecting to the server, retrying automatically ({state.loadError}){" "}
      <button onClick={() => void refreshAll()} className="ml-2 font-semibold underline underline-offset-2">
        Retry
      </button>
    </div>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const route = useRoute();
  const [how, setHow] = useState(false);
  useEffect(() => {
    document.title = `${PAGE_TITLE[route]} | Purser`;
  }, [route]);
  return (
    <DrawerProvider>
      <Backdrop />
      <Rail route={route} />
      <div className="min-[1280px]:pl-[88px]">
      <Header route={route} onHow={() => setHow(true)} onLogout={onLogout} />
      <FrozenBanner />
      <LoadError />
      {route === "live" && <LivePage />}
      {route === "approvals" && <ApprovalsPage />}
      {route === "lab" && <AttackLabPage />}
      {route === "policies" && <PoliciesPage />}
      {route === "reconciliation" && <ReconciliationPage />}
      </div>
      <HowItWorks open={how} onClose={() => setHow(false)} />
    </DrawerProvider>
  );
}

export function App() {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const logout = useCallback(() => {
    clearToken();
    setTokenState(null);
  }, []);

  // any 401 from the API (token rotated, server restarted with a new one) returns to the login screen
  useEffect(() => {
    const onUnauthorized = () => {
      if (isDemo()) setLoginNotice("Your demo session expired. Start a new one, or sign in with the admin token.");
      logout();
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [logout]);

  return (
    <ToastProvider>
      {token ? (
        <StoreProvider token={token}>
          <Shell onLogout={logout} />
        </StoreProvider>
      ) : (
        <LoginPage onLogin={setTokenState} />
      )}
    </ToastProvider>
  );
}
