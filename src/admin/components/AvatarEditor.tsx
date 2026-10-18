import { useQueryClient } from "@tanstack/react-query";
import { Camera, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../lib/api";
import { Avatar, Spinner, useFeedback } from "./ui";

const TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 1024 * 1024;

/** Upload or remove a staff profile picture. `staffId` of "me" changes your own. */
export function AvatarEditor({ staffId, name, src, onChanged }: { staffId: number | "me"; name: string; src: string | null; onChanged?: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const { toast, confirm } = useFeedback();
  const client = useQueryClient();

  const done = (text: string) => {
    toast(text);
    void client.invalidateQueries({ queryKey: ["session"] });
    void client.invalidateQueries({ queryKey: ["staff"] });
    onChanged?.();
  };
  const run = async (work: () => Promise<unknown>, text: string) => {
    setBusy(true);
    try {
      await work();
      done(text);
    } catch (err) {
      toast(err instanceof Error ? err.message : "That did not work.", "bad");
    } finally {
      setBusy(false);
    }
  };

  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!TYPES.includes(file.type)) return toast("Choose a PNG, JPEG or WebP image.", "bad");
    if (file.size > MAX_BYTES) return toast("The picture must be 1 MB or smaller.", "bad");
    void run(() => api.upload(`/api/staff/users/${staffId}/avatar`, file), "Profile picture updated.");
  };

  return (
    <div className="avatar-editor">
      <Avatar name={name} src={src} xl />
      <div className="avatar-editor-actions">
        <div className="row-actions">
          <button type="button" className="button button-small" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? <Spinner /> : <Camera size={15} />} {src ? "Change picture" : "Add picture"}
          </button>
          {src && (
            <button
              type="button"
              className="button button-ghost button-small"
              disabled={busy}
              onClick={async () => {
                if (await confirm({ title: "Remove profile picture?", body: "Initials will show instead.", confirmLabel: "Remove" }))
                  void run(() => api.del(`/api/staff/users/${staffId}/avatar`), "Profile picture removed.");
              }}
            >
              <Trash2 size={15} /> Remove
            </button>
          )}
        </div>
        <small className="muted">PNG, JPEG or WebP, up to 1 MB. A square picture works best.</small>
        <input
          ref={input}
          type="file"
          accept={TYPES.join(",")}
          hidden
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
