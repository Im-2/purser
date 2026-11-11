import { useCallback, useEffect, useState } from "react";
import { DrawerProvider } from "./components/AttemptDrawer";
import { FrozenBanner } from "./components/FrozenBanner";
import { Header } from "./components/Header";
import { HowItWorks } from "./components/HowItWorks";
import { UNAUTHORIZED_EVENT, clearToken, getToken } from "./lib/api";
import { useRoute } from "./lib/route";
import { StoreProvider, useStore } from "./lib/store";
import { ToastProvider } from "./lib/toast";
import { ApprovalsPage } from "./pages/Approvals";
import { AttackLabPage } from "./pages/AttackLab";
import { ComingNextPage } from "./pages/ComingNext";
import { LivePage } from "./pages/Live";
import { LoginPage } from "./pages/Login";

function LoadError() {
  const { state, refreshAll } = useStore();
  if (!state.loadError) return null;
  return (
    <div role="alert" className="border-b border-escalate/40 bg-escalate/10 px-6 py-2.5 text-center text-[13px] text-escalate">
      Could not load data: {state.loadError}{" "}
      <button onClick={() => void refreshAll()} className="ml-2 font-semibold underline underline-offset-2">
        Retry
      </button>
    </div>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const route = useRoute();
  const [how, setHow] = useState(false);
  return (
    <DrawerProvider>
      <Header route={route} onHow={() => setHow(true)} onLogout={onLogout} />
      <FrozenBanner />
      <LoadError />
      {route === "live" && <LivePage />}
      {route === "approvals" && <ApprovalsPage />}
      {route === "lab" && <AttackLabPage />}
      {route === "policies" && <ComingNextPage which="policies" />}
      {route === "reconciliation" && <ComingNextPage which="reconciliation" />}
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
    window.addEventListener(UNAUTHORIZED_EVENT, logout);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, logout);
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
