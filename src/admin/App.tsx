import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";
import { Route, Switch } from "wouter";
import { StepUpHost } from "./components/StepUp";
import { EmptyState, PageHeader, Spinner } from "./components/ui";
import { ApiError, api, onSessionLost, setCsrf, type SessionInfo } from "./lib/api";
import { useFavicon, useLogo } from "./lib/branding";
import { SessionProvider, useCan } from "./lib/session";
import { useVisit } from "./lib/visits";
import { ClientDetail, ClientsList } from "./pages/Clients";
import { Emails } from "./pages/Emails";
import { EmailSettings } from "./pages/EmailSettings";
import { ComposeEmail, EmailTemplates, SentEmailDetail, SentEmails } from "./pages/Messages";
import { KycReview, KycWorkbench } from "./pages/Kyc";
import { Account } from "./pages/Account";
import { AuditLog } from "./pages/Audit";
import { BrandingSettings } from "./pages/Branding";
import { ChangePassword } from "./pages/ChangePassword";
import { Dashboard } from "./pages/Dashboard";
import { Layout } from "./pages/Layout";
import { AuthScreen, Login } from "./pages/Login";
import { Roles } from "./pages/Roles";
import { StaffDetail, StaffList } from "./pages/Staff";

// The money screens load when first opened, so the rest of the CRM stays small.
const DepositsQueue = lazy(() => import("./pages/Deposits").then((m) => ({ default: m.DepositsQueue })));
const DepositWorkbench = lazy(() => import("./pages/Deposits").then((m) => ({ default: m.DepositWorkbench })));
const WithdrawalsQueue = lazy(() => import("./pages/Withdrawals").then((m) => ({ default: m.WithdrawalsQueue })));
const WithdrawalWorkbench = lazy(() => import("./pages/Withdrawals").then((m) => ({ default: m.WithdrawalWorkbench })));
const PaymentMethods = lazy(() => import("./pages/PaymentMethods").then((m) => ({ default: m.PaymentMethods })));

const Loading = ({ children }: { children: React.ReactNode }) => (
  <Suspense
    fallback={
      <div className="center-screen loading-block">
        <Spinner size={22} />
      </div>
    }
  >
    {children}
  </Suspense>
);

/** `permission`: every one of them is needed; `anyOf`: one of them is enough. */
function Guarded({ permission = [], anyOf, children }: { permission?: string | string[]; anyOf?: string[]; children: React.ReactNode }) {
  const can = useCan();
  return can(...[permission].flat()) && (!anyOf || anyOf.some((p) => can(p))) ? (
    <>{children}</>
  ) : (
    <div className="panel">
      <EmptyState icon={<Lock size={36} />} title="No access">
        Your role does not include this page. Ask a Super Admin if you need it.
      </EmptyState>
    </div>
  );
}

function Splash({ children }: { children: React.ReactNode }) {
  const logo = useLogo();
  return (
    <div className="center-screen">
      <div>
        <img src={logo} alt="BIS CRM" />
        <div>{children}</div>
      </div>
    </div>
  );
}

export function App() {
  const client = useQueryClient();
  useFavicon();
  const visit = useVisit();
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
    client.removeQueries({ predicate: (q) => q.queryKey[0] !== "branding" });
    void session.refetch();
  };

  useEffect(() => {
    onSessionLost(() => client.setQueryData(["session"], null));
    return () => onSessionLost(null);
  }, [client]);

  if (session.isLoading)
    return (
      <Splash>
        <Spinner size={22} />
      </Splash>
    );
  if (session.error) return <Splash>The CRM is not reachable right now. Try again shortly.</Splash>;
  if (!session.data) return <Login onSignedIn={reload} />;
  if (session.data.staff.mustChangePassword) {
    return (
      <AuthScreen>
        <ChangePassword forced onDone={reload} />
      </AuthScreen>
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
          <Route path="/clients">
            <Guarded permission="client.view">
              <ClientsList />
            </Guarded>
          </Route>
          <Route path="/clients/:id">
            {(params) => (
              <Guarded permission="client.view">
                <ClientDetail id={params.id} />
              </Guarded>
            )}
          </Route>
          <Route path="/kyc">
            <Guarded permission="kyc.view">
              <KycReview />
            </Guarded>
          </Route>
          <Route path="/kyc/:id">
            {(params) => (
              <Guarded permission={["kyc.view", "kyc.documents"]}>
                {/* A fresh screen for every item, so nothing from the last one carries over. */}
                <KycWorkbench key={`${params.id}:${visit}`} id={params.id} />
              </Guarded>
            )}
          </Route>
          <Route path="/deposits">
            <Guarded permission="deposit.view">
              <Loading>
                <DepositsQueue />
              </Loading>
            </Guarded>
          </Route>
          <Route path="/deposits/:id">
            {(params) => (
              <Guarded permission={["deposit.view", "deposit.proof"]}>
                {/* A fresh screen for every item, so nothing from the last one carries over. */}
                <Loading>
                  <DepositWorkbench key={`${params.id}:${visit}`} id={params.id} />
                </Loading>
              </Guarded>
            )}
          </Route>
          <Route path="/withdrawals">
            <Guarded permission="withdrawal.view">
              <Loading>
                <WithdrawalsQueue />
              </Loading>
            </Guarded>
          </Route>
          <Route path="/withdrawals/:id">
            {(params) => (
              <Guarded permission="withdrawal.view">
                <Loading>
                  <WithdrawalWorkbench key={`${params.id}:${visit}`} id={params.id} />
                </Loading>
              </Guarded>
            )}
          </Route>
          <Route path="/payment-methods">
            <Guarded anyOf={["payment.manage", "deposit.view", "withdrawal.view"]}>
              <Loading>
                <PaymentMethods />
              </Loading>
            </Guarded>
          </Route>
          <Route path="/emails">
            <Guarded permission="comms.view">
              <Emails />
            </Guarded>
          </Route>
          <Route path="/messages">
            <Guarded permission="comms.view">
              <SentEmails />
            </Guarded>
          </Route>
          <Route path="/messages/new">
            <Guarded permission="comms.send">
              <ComposeEmail />
            </Guarded>
          </Route>
          <Route path="/messages/templates">
            <Guarded permission="comms.view">
              <EmailTemplates />
            </Guarded>
          </Route>
          <Route path="/messages/:id">
            {(params) => (
              <Guarded permission="comms.view">
                <SentEmailDetail id={params.id} />
              </Guarded>
            )}
          </Route>
          <Route path="/settings/email">
            <Guarded permission="settings.view">
              <EmailSettings />
            </Guarded>
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
          <Route path="/settings/branding">
            <Guarded permission="settings.view">
              <BrandingSettings />
            </Guarded>
          </Route>
          <Route path="/account">
            <Account />
          </Route>
          <Route>
            <PageHeader title="Page not found" description="This address does not match any page in the CRM." />
          </Route>
        </Switch>
      </Layout>
    </SessionProvider>
  );
}
