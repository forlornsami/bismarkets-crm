import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImageUp, RotateCcw } from "lucide-react";
import { useRef, useState } from "react";
import { Badge, PageHeader, Spinner, useFeedback } from "../components/ui";
import { api, formatDate } from "../lib/api";
import { BRANDING_DEFAULTS, useBranding, type BrandAsset } from "../lib/branding";
import { useCan } from "../lib/session";

type Slot = "logo_light" | "logo_dark" | "favicon";

const SLOTS: { slot: Slot; field: "logoLight" | "logoDark" | "favicon"; title: string; help: string; preview: string }[] = [
  { slot: "logo_light", field: "logoLight", title: "Logo for light mode", help: "Dark lettering on a transparent background. Shown on white pages.", preview: "on-light" },
  { slot: "logo_dark", field: "logoDark", title: "Logo for dark mode", help: "White lettering on a transparent background. Shown on dark pages and the sign-in screen.", preview: "on-dark" },
  { slot: "favicon", field: "favicon", title: "Browser icon", help: "The small icon in the browser tab. A square PNG of 64 to 512 pixels works best.", preview: "on-checker" },
];

const TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 1024 * 1024;

export function BrandingSettings() {
  const can = useCan();
  const branding = useBranding().data ?? BRANDING_DEFAULTS;
  const editable = can("settings.manage");
  return (
    <>
      <PageHeader
        title="Branding"
        description="The logos and browser icon staff see across the CRM. The right logo is picked automatically for light and dark mode."
        badge={!editable && <Badge tone="neutral">View only</Badge>}
      />
      <div className="brand-slots">
        {SLOTS.map((s) => (
          <BrandSlot key={s.slot} {...s} asset={branding[s.field]} editable={editable} />
        ))}
      </div>
    </>
  );
}

function BrandSlot({ slot, title, help, preview, asset, editable }: (typeof SLOTS)[number] & { asset: BrandAsset; editable: boolean }) {
  const client = useQueryClient();
  const { toast, confirm } = useFeedback();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const done = (text: string) => {
    toast(text);
    void client.invalidateQueries({ queryKey: ["branding"] });
  };
  const upload = useMutation({
    mutationFn: (file: File) => api.upload(`/api/staff/branding/${slot}`, file),
    onSuccess: () => done(`${title} updated.`),
    onError: (err) => toast(err instanceof Error ? err.message : "Upload failed.", "bad"),
  });
  const reset = useMutation({
    mutationFn: () => api.del(`/api/staff/branding/${slot}`),
    onSuccess: () => done(`${title} reset to the BIS default.`),
    onError: (err) => toast(err instanceof Error ? err.message : "Reset failed.", "bad"),
  });

  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!TYPES.includes(file.type)) return toast("Choose a PNG, JPEG or WebP image. SVG files are not accepted.", "bad");
    if (file.size > MAX_BYTES) return toast("The image must be 1 MB or smaller.", "bad");
    upload.mutate(file);
  };
  const busy = upload.isPending || reset.isPending;

  return (
    <section className="panel brand-slot">
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          <p>{help}</p>
        </div>
      </div>
      <div className={`brand-preview ${preview}`}>
        <img src={asset.url} alt={`${title} preview`} className={slot === "favicon" ? "icon-preview" : undefined} />
      </div>
      <div className="brand-meta">
        <span>{asset.custom ? `Uploaded ${formatDate(asset.updatedAt)} · ${asset.width}×${asset.height}px` : "BIS default"}</span>
        {asset.custom ? <Badge tone="info">Custom</Badge> : <Badge tone="neutral">Default</Badge>}
      </div>
      {editable && (
        <>
          <div
            className={over ? "dropzone over" : "dropzone"}
            role="button"
            tabIndex={0}
            onClick={() => input.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              pick(e.dataTransfer.files[0]);
            }}
          >
            {busy ? <Spinner size={20} /> : <ImageUp size={20} />}
            <span>
              <strong>Choose a file</strong> or drag it here
            </span>
            <span>PNG, JPEG or WebP, up to 1 MB</span>
          </div>
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
          {asset.custom && (
            <button
              type="button"
              className="button button-ghost button-small"
              disabled={busy}
              onClick={async () => (await confirm({ title: "Go back to the default?", body: `The uploaded ${title.toLowerCase()} is removed and the BIS default is used again.`, confirmLabel: "Use default" })) && reset.mutate()}
            >
              <RotateCcw size={14} /> Use the BIS default
            </button>
          )}
        </>
      )}
    </section>
  );
}
