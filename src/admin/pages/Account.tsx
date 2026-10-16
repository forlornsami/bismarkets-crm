import { PageHeader, Avatar, ThemeSwitch } from "../components/ui";
import { formatDate } from "../lib/api";
import { useSession } from "../lib/session";
import { ChangePassword } from "./ChangePassword";

export function Account() {
  const session = useSession();
  const { staff } = session;
  return (
    <>
      <PageHeader title="My account" description="Your profile, appearance and password." />
      <div className="columns">
        <section className="panel">
          <div className="card-head">
            <div className="cell-person">
              <Avatar name={staff.name} large />
              <div>
                <h2 className="flush">{staff.name}</h2>
                <span className="muted">{staff.email}</span>
              </div>
            </div>
          </div>
          <dl className="details">
            <dt>Role</dt>
            <dd>{staff.role.name}</dd>
            <dt>Permissions</dt>
            <dd>{session.permissions.length}</dd>
            <dt>Session ends</dt>
            <dd>{formatDate(session.expiresAt)}</dd>
            <dt>Appearance</dt>
            <dd>
              <ThemeSwitch />
            </dd>
          </dl>
        </section>
        <ChangePassword forced={false} onDone={() => undefined} />
      </div>
    </>
  );
}
