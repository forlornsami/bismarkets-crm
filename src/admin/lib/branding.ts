import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "./api";
import { useTheme } from "./theme";

export interface BrandAsset {
  url: string;
  custom: boolean;
  width: number | null;
  height: number | null;
  updatedAt: string | null;
}

export interface Branding {
  logoLight: BrandAsset;
  logoDark: BrandAsset;
  favicon: BrandAsset;
}

export const BRANDING_DEFAULTS: Branding = {
  logoLight: { url: "/brand/logo-light.png", custom: false, width: null, height: null, updatedAt: null },
  logoDark: { url: "/brand/logo-dark.png", custom: false, width: null, height: null, updatedAt: null },
  favicon: { url: "/brand/favicon.png", custom: false, width: null, height: null, updatedAt: null },
};

export const useBranding = () =>
  useQuery({
    queryKey: ["branding"],
    queryFn: () => api.get<Branding>("/api/staff/branding"),
    staleTime: 5 * 60_000,
    placeholderData: BRANDING_DEFAULTS,
  });

/** The logo for the current theme: dark text on light backgrounds and white text on dark ones. */
export function useLogo(): string {
  const { theme } = useTheme();
  const branding = useBranding().data ?? BRANDING_DEFAULTS;
  return theme === "dark" ? branding.logoDark.url : branding.logoLight.url;
}

/** Keeps the browser tab icon in step with the uploaded favicon. */
export function useFavicon() {
  const url = (useBranding().data ?? BRANDING_DEFAULTS).favicon.url;
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = url;
  }, [url]);
}
