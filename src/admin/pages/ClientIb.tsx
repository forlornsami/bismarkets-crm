import { Network } from "lucide-react";
import { Link } from "wouter";
import { IbStatusBadge, PartnerBadge, type IbStatus } from "../components/ib";
import { CopyText } from "../components/money";
import { Badge } from "../components/ui";
import { formatDate } from "../lib/api";

/** The client page's IB block, as the staff API sends it (null without ib.view). */
export interface ClientIbBlock {
  /** The client's latest application, or "none". */
  status: IbStatus | "none";
  applicationId: number | null;
  partner: {
    status: "active" | "removed";
    tier: string;
    approvedAt: string;
    referralCode: string;
    directClients: number;
    network: number;
    removedAt: string | null;
  } | null;
  sponsor: { id: number; name: string | null; isIb: boolean } | null;
}

/** The "IB partnership" panel on a client's page: whether they are an IB, their level and code, who they brought in and who brought them. */
export function ClientIb({ clientId, ib }: { clientId: number; ib: ClientIbBlock }) {
  const p = ib.partner;
  return (
    <section className="panel">
      <div className="card-head">
        <h2 className="flush">
          <Network size={18} /> IB partnership
        </h2>
        {p ? <PartnerBadge status={p.status} /> : ib.status === "none" ? <Badge tone="neutral">Not an IB</Badge> : <IbStatusBadge status={ib.status} />}
      </div>
      <dl className="details">
        {p ? (
          <>
            <dt>Level</dt>
            <dd>{p.tier}</dd>
            <dt>Referral code</dt>
            <dd>
              <CopyText value={p.referralCode} label="referral code" />
            </dd>
            <dt>Direct clients</dt>
            <dd>{p.directClients.toLocaleString()}</dd>
            <dt>Network</dt>
            <dd>
              {p.network.toLocaleString()}
              <small className="muted block">Everyone below them, up to 10 levels down</small>
            </dd>
            <dt>IB since</dt>
            <dd>{formatDate(p.approvedAt)}</dd>
            {p.removedAt && (
              <>
                <dt>Ended</dt>
                <dd>{formatDate(p.removedAt)}</dd>
              </>
            )}
          </>
        ) : (
          <>
            <dt>Status</dt>
            <dd>{ib.status === "none" ? <span className="muted">The client has not applied to the IB program.</span> : <IbStatusBadge status={ib.status} />}</dd>
          </>
        )}
        <dt>Sponsor</dt>
        <dd>
          {ib.sponsor ? (
            <>
              <Link href={`/clients/${ib.sponsor.id}`}>{ib.sponsor.name ?? `Client ${ib.sponsor.id}`}</Link> {ib.sponsor.isIb && <Badge tone="info">IB</Badge>}
            </>
          ) : (
            <span className="muted">Nobody</span>
          )}
        </dd>
      </dl>
      <div className="kyc-actions">
        {ib.applicationId && (
          <Link href={`/ib/${ib.applicationId}`} className="button button-small">
            Open the application
          </Link>
        )}
        <Link href={`/clients?referredBy=${clientId}`} className="button button-small button-ghost">
          Clients they referred
        </Link>
      </div>
    </section>
  );
}
