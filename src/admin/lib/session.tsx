import { createContext, useContext, type ReactNode } from "react";
import type { SessionInfo } from "./api";

const SessionContext = createContext<SessionInfo | null>(null);

export const SessionProvider = ({ value, children }: { value: SessionInfo; children: ReactNode }) => (
  <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
);

export function useSession(): SessionInfo {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}

export function useCan() {
  const { permissions } = useSession();
  const set = new Set(permissions);
  return (...needed: string[]) => needed.every((p) => set.has(p));
}
