import type { StaffContext } from "./staff/session";

declare global {
  namespace Express {
    interface Request {
      /** The caller's IP after trusted-proxy resolution, IPv4-mapped prefix removed. */
      clientIp: string;
      /** Set by the staff session middleware on authenticated staff requests. */
      staff?: StaffContext;
    }
  }
}

export {};
