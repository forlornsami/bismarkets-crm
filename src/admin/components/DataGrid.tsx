import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortable?: boolean;
  width?: string;
}

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterDef {
  key: string;
  label: string;
  options: FilterOption[];
}

export interface GridState {
  page: number;
  pageSize: number;
  sort?: string;
  dir?: "asc" | "desc";
  q?: string;
  filters: Record<string, string>;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  total: number;
  pages: number;
  state: GridState;
  onChange: (next: GridState) => void;
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  filters?: FilterDef[];
  searchPlaceholder?: string;
  loading?: boolean;
  error?: unknown;
  toolbar?: ReactNode;
  expanded?: (row: T) => ReactNode | null;
}

/** Server-side grid: search, dropdown filters, sortable headers and pagination all round-trip to the API. */
export function DataGrid<T>(props: Props<T>) {
  const { columns, rows, total, pages, state, onChange, rowKey, onRowClick, filters = [], loading, error } = props;
  const set = (patch: Partial<GridState>) => onChange({ ...state, page: 1, ...patch });
  const sortBy = (key: string) =>
    set({ sort: key, dir: state.sort === key && state.dir === "desc" ? "asc" : "desc" });
  const first = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
  const last = Math.min(total, state.page * state.pageSize);

  return (
    <div className="grid">
      <div className="grid-toolbar">
        {props.searchPlaceholder !== undefined && (
          <input
            type="search"
            className="input grid-search"
            placeholder={props.searchPlaceholder}
            defaultValue={state.q ?? ""}
            onKeyDown={(e) => {
              if (e.key === "Enter") set({ q: (e.target as HTMLInputElement).value.trim() || undefined });
            }}
            onBlur={(e) => {
              const q = e.target.value.trim() || undefined;
              if (q !== state.q) set({ q });
            }}
            aria-label="Search"
          />
        )}
        {filters.map((f) => (
          <select
            key={f.key}
            className="input grid-filter"
            aria-label={f.label}
            value={state.filters[f.key] ?? ""}
            onChange={(e) => set({ filters: { ...state.filters, [f.key]: e.target.value } })}
          >
            <option value="">{f.label}: all</option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ))}
        <div className="grid-toolbar-end">{props.toolbar}</div>
      </div>
      {Boolean(error) && <p className="error-text">{error instanceof Error ? error.message : "Could not load data."}</p>}
      <div className="grid-scroll">
        <table className="table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} style={c.width ? { width: c.width } : undefined}>
                  {c.sortable ? (
                    <button type="button" className="sort-button" onClick={() => sortBy(c.key)} aria-sort={state.sort === c.key ? (state.dir === "asc" ? "ascending" : "descending") : "none"}>
                      {c.header}
                      <span className="sort-mark">{state.sort === c.key ? (state.dir === "asc" ? "▲" : "▼") : ""}</span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows?.map((row) => {
              const extra = props.expanded?.(row);
              return [
                <tr key={rowKey(row)} className={onRowClick ? "row-link" : undefined} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                  {columns.map((c) => (
                    <td key={c.key}>{c.render(row)}</td>
                  ))}
                </tr>,
                extra ? (
                  <tr key={`${rowKey(row)}-x`} className="row-expanded">
                    <td colSpan={columns.length}>{extra}</td>
                  </tr>
                ) : null,
              ];
            })}
            {rows && rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="empty">
                  Nothing matches these filters.
                </td>
              </tr>
            )}
            {!rows && loading && (
              <tr>
                <td colSpan={columns.length} className="empty">
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="grid-footer">
        <span>
          {first}–{last} of {total}
        </span>
        <select className="input input-small" aria-label="Rows per page" value={state.pageSize} onChange={(e) => set({ pageSize: Number(e.target.value) })}>
          {[10, 25, 50, 100].map((n) => (
            <option key={n} value={n}>
              {n} per page
            </option>
          ))}
        </select>
        <button type="button" className="button button-small" disabled={state.page <= 1} onClick={() => onChange({ ...state, page: state.page - 1 })}>
          Previous
        </button>
        <span>
          Page {state.page} of {pages}
        </span>
        <button type="button" className="button button-small" disabled={state.page >= pages} onClick={() => onChange({ ...state, page: state.page + 1 })}>
          Next
        </button>
      </div>
    </div>
  );
}

export const gridQuery = (s: GridState) => ({ page: s.page, pageSize: s.pageSize, sort: s.sort, dir: s.dir, q: s.q, ...s.filters });
