import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { CATEGORY_LABEL, KycStatusBadge, WHAT, type Category, type KycSubmission } from "../components/kyc";
import { Dialog, ErrorText, Field, Spinner, useFeedback } from "../components/ui";
import { api, formatDate, qs, type Page } from "../lib/api";
import { useCan } from "../lib/session";
import { KYC_TYPES } from "../../shared/kyc-types";

// The KYC panel on a client's page, with staff uploads and approving without
// documents. It lives apart from the KYC review screens, which load only when opened.

/** The KYC panel on a client's page. */
export function ClientKyc({ clientId, status }: { clientId: number; status: "none" | "partial" | "pending" | "approved" | "rejected" }) {
  const can = useCan();
  const list = useQuery({
    queryKey: ["client-kyc", clientId],
    queryFn: () => api.get<Page<KycSubmission>>(`/api/staff/kyc${qs({ clientId, status: "all", pageSize: 50 })}`),
    enabled: can("kyc.view"),
  });
  const mayOpen = can("kyc.documents");
  // Newest first; an upload the client took back no longer counts.
  const latest = (category: Category) => list.data?.items.find((s) => s.category === category && s.status !== "withdrawn");
  const [action, setAction] = useState<{ category: Category; mode: "upload" | "approve" } | null>(null);
  return (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">
          <BadgeCheck size={18} /> Verification
        </h2>
        <KycStatusBadge status={status} />
      </div>
      {!can("kyc.view") ? (
        <p className="muted">You do not have access to KYC documents.</p>
      ) : list.error ? (
        <ErrorText error={list.error} />
      ) : !list.data ? (
        <Spinner />
      ) : (
        <dl className="details">
          {(["identity", "address"] as const).map((cat) => {
            const s = latest(cat);
            const what = (
              <>
                <KycStatusBadge status={s?.status ?? "none"} /> {s?.documentType}
              </>
            );
            return [
              <dt key={`${cat}-t`}>{CATEGORY_LABEL[cat]}</dt>,
              <dd key={`${cat}-d`}>
                {s && mayOpen ? <Link href={`/kyc/${s.id}`}>{what}</Link> : what}
                {s && (
                  <small className="muted block">
                    Sent {formatDate(s.submittedAt)}
                    {s.decidedBy && (s.status === "approved" || s.status === "rejected") ? ` · ${s.status} by ${s.decidedBy}, ${formatDate(s.decidedAt)}` : ""}
                  </small>
                )}
                {s?.rejectReason && <small className="muted block">Reason: {s.rejectReason}</small>}
                {s?.source === "staff" && (
                  <small className="muted block">
                    {s.documents ? `Uploaded by ${s.uploadedBy}` : `Added without documents by ${s.uploadedBy}`}
                    {s.staffNote ? `: ${s.staffNote}` : ""}
                  </small>
                )}
                {(!s || s.status === "rejected") && (can("kyc.upload") || can("kyc.override")) && (
                  <span className="kyc-actions">
                    {can("kyc.upload") && (
                      <button type="button" className="button button-small" onClick={() => setAction({ category: cat, mode: "upload" })}>
                        Upload for client
                      </button>
                    )}
                    {can("kyc.override") && (
                      <button type="button" className="button button-small" onClick={() => setAction({ category: cat, mode: "approve" })}>
                        Approve without documents
                      </button>
                    )}
                  </span>
                )}
              </dd>,
            ];
          })}
        </dl>
      )}
      {action && <StaffKycDialog clientId={clientId} category={action.category} mode={action.mode} onClose={() => setAction(null)} />}
    </section>
  );
}

/** A small preview of a chosen file, drawn on a canvas (blob: images are blocked by the CRM's content policy). */
function ChosenFile({ file }: { file: File }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let bitmap: ImageBitmap | null = null;
    setPreview(false);
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return;
    createImageBitmap(file, { resizeWidth: 144, resizeQuality: "medium", imageOrientation: "from-image" })
      .then((b) => {
        bitmap = b;
        const canvas = ref.current;
        if (cancelled || !canvas) return;
        canvas.width = b.width;
        canvas.height = b.height;
        canvas.getContext("2d")?.drawImage(b, 0, 0);
        setPreview(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      bitmap?.close();
    };
  }, [file]);
  const size = file.size > 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(file.size / 1024)} KB`;
  return (
    <span className="file-chosen">
      <canvas ref={ref} className="file-thumb" hidden={!preview} aria-hidden />
      {!preview && <FileText size={28} className="muted" />}
      <span>
        <strong>{file.name}</strong>
        <small className="muted block">{size}</small>
      </span>
    </span>
  );
}

/** Upload documents for the client, or approve without documents. Both ask for a 2FA code and are audited. */
function StaffKycDialog({ clientId, category, mode, onClose }: { clientId: number; category: Category; mode: "upload" | "approve"; onClose: () => void }) {
  const client = useQueryClient();
  const { toast } = useFeedback();
  const types = KYC_TYPES[category].subTypes;
  const [subType, setSubType] = useState<number>(types[0]!.id);
  const [files, setFiles] = useState<(File | null)[]>([null, null]);
  const [note, setNote] = useState("");
  const needs = types.find((t) => t.id === subType)?.documents ?? 1;
  const what = WHAT[category];
  const send = useMutation({
    mutationFn: () => {
      if (mode === "approve") return api.post<KycSubmission>("/api/staff/kyc/approve-without-documents", { clientId, category, subType, reason: note.trim() });
      const form = new FormData();
      form.set("client_id", String(clientId));
      form.set("type", String(KYC_TYPES[category].type));
      form.set("sub_type", String(subType));
      form.set("note", note.trim());
      files.slice(0, needs).forEach((f, i) => f && form.set(`document${i + 1}`, f));
      return api.form<KycSubmission>("/api/staff/kyc/upload", form);
    },
    onSuccess: () => {
      toast(mode === "approve" ? `The client's ${what} is approved without documents.` : `Uploaded. The ${what} is now waiting for another reviewer.`);
      for (const key of [["kyc"], ["kyc-summary"], ["client", String(clientId)], ["client-kyc", clientId], ["client-activity", String(clientId)], ["clients"]]) void client.invalidateQueries({ queryKey: key });
      onClose();
    },
  });
  const ready = note.trim().length >= 5 && (mode === "approve" || files.slice(0, needs).every(Boolean));
  return (
    <Dialog open title={mode === "approve" ? `Approve ${what} without documents` : `Upload ${what} for the client`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <p className="muted">
          {mode === "approve"
            ? "Use this only when the client was verified another way. The client is told they are verified, and the reason is kept in the audit log."
            : "For documents the client sent another way, such as by email. Another reviewer approves them from the KYC queue."}
        </p>
        <Field label="Document type">
          <select
            className="input"
            value={subType}
            onChange={(e) => {
              setSubType(Number(e.target.value));
              // A file picked for another type must never go up unseen.
              setFiles([null, null]);
            }}
          >
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        {mode === "upload" &&
          Array.from({ length: needs }, (_, i) => (
            <Field key={`${subType}-${i}`} label={needs === 2 ? (i === 0 ? "Front" : "Back") : "Document"} hint="JPG, PNG, WebP or HEIC photo, or a PDF, up to 10 MB">
              <input
                className="input"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,.heic,application/pdf,.pdf"
                onChange={(e) => setFiles((f) => f.map((old, j) => (j === i ? (e.target.files?.[0] ?? null) : old)))}
              />
              {files[i] && <ChosenFile file={files[i]} />}
            </Field>
          ))}
        <Field label={mode === "approve" ? "How the client was verified" : "Where these documents came from"} hint="Kept in the audit log. You'll be asked for your 2FA code.">
          <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} required />
        </Field>
        <ErrorText error={send.error} />
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={send.isPending || !ready}>
            {send.isPending && <Spinner />} {mode === "approve" ? "Approve without documents" : "Upload"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
