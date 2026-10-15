import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Route, Switch } from "wouter";
import { StepUpHost } from "./components/StepUp";
import { ApiError, api, onSessionLost, setCsrf, type SessionInfo } from "./lib/api";
import { SessionProvider, useCan } from "./lib/session";
import { AuditLog } from "./pages/Audit";
import { ChangePassword } from "./pages/ChangePassword";
import { Dashboard } from "./pages/Dashboard";
import { Layout } from "./pages/Layout";
import { Login } from "./pages/Login";
import { Roles } from "./pages/Roles";
import { StaffDetail, StaffList } from "./pages/Staff";

function Guarded({ permission, children }: { permission: string; children: React.ReactNode }) {
  const can = useCan();
  return can(permission) ? <>{children}</> : <p>You do not have access to this page.</p>;
}

export function App() {
  const client = useQueryClient();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      try {
        const s = await api.get<SessionInfo>("/api/staff/auth/session");
        setCsrf(s.csrfToken);
        return s;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
    refetchOnWindowFocus: true,
  });
  const reload = () => {
    client.clear();
    void session.refetch();
  };

  useEffect(() => {
    onSessionLost(() => client.setQueryData(["session"], null));
    return () => onSessionLost(null);
  }, [client]);

  if (session.isLoading) return <p className="center">Loading…</p>;
  if (session.error) return <p className="center error-text">The CRM is not reachable right now. Try again shortly.</p>;
  if (!session.data) return <Login onSignedIn={reload} />;
  if (session.data.staff.mustChangePassword) {
    return (
      <main className="login">
        <ChangePassword forced onDone={reload} />
      </main>
    );
  }

  return (
    <SessionProvider value={session.data}>
      <StepUpHost />
      <Layout onSignedOut={reload}>
        <Switch>
          <Route path="/">
            <Dashboard />
          </Route>
          <Route path="/staff">
            <Guarded permission="staff.view">
              <StaffList />
            </Guarded>
          </Route>
          <Route path="/staff/:id">
            {(params) => (
              <Guarded permission="staff.view">
                <StaffDetail id={params.id} />
              </Guarded>
            )}
          </Route>
          <Route path="/roles">
            <Guarded permission="role.view">
              <Roles />
            </Guarded>
          </Route>
          <Route path="/audit">
            <Guarded permission="audit.view">
              <AuditLog />
            </Guarded>
          </Route>
          <Route path="/account">
            <h1>My account</h1>
            <ChangePassword forced={false} onDone={() => undefined} />
          </Route>
          <Route>
            <p>Page not found.</p>
          </Route>
        </Switch>
      </Layout>
    </SessionProvider>
  );
}
