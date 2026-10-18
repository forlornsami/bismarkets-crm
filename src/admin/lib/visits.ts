import { useSyncExternalStore } from "react";

// "Approve and next" can lead back to the item just decided, now at its next
// step (a withdrawal approved and then paid by the same person). The address
// stays the same, so the screen is keyed by this count too and starts afresh.
let visits = 0;
const listeners = new Set<() => void>();

export function reopenItem() {
  visits += 1;
  listeners.forEach((l) => l());
}

export const useVisit = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => visits,
  );
