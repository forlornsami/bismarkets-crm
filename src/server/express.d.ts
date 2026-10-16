import type { StaffContext } from "./staff/session";
import type { ClientContext } from "./clients/session";

declare global {
  namespace Express {
    interface Request {
      /** The caller's IP after trusted-proxy resolution, IPv4-mapped prefix removed. */
      clientIp: string;
      /** Set by the staff session middleware on authenticated staff requests. */
      staff?: StaffContext;
      /** Set by the client token middleware on authenticated client API requests. */
      client?: ClientContext;
    }
  }
}

export {};
