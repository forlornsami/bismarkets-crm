import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "bis-crm-theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    // Storage can be blocked; fall back to the system setting.
  }
  return "system";
}

const resolve = (pref: ThemePreference): Theme => (pref === "system" ? (media().matches ? "dark" : "light") : pref);

/** Applies the saved theme before the first render so the page never flashes the wrong colours. */
export const applyInitialTheme = () => {
  document.documentElement.dataset.theme = resolve(readPreference());
};

interface ThemeValue {
  preference: ThemePreference;
  theme: Theme;
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPref] = useState<ThemePreference>(readPreference);
  const [systemDark, setSystemDark] = useState(() => media().matches);
  useEffect(() => {
    const m = media();
    const onChange = () => setSystemDark(m.matches);
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, []);
  const theme: Theme = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const setPreference = (pref: ThemePreference) => {
    setPref(pref);
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      // Not saved; the choice still applies for this visit.
    }
  };
  return <ThemeContext.Provider value={{ preference, theme, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme outside ThemeProvider");
  return value;
}
