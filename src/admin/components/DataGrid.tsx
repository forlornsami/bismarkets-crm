import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Inbox, Search, SlidersHorizontal, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { EmptyState } from "./ui";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortable?: boolean;
  width?: string;
  /** Left out on tablets and small laptops, where every column would not fit. Phones show it on the card. */
  optional?: boolean;
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
  emptyText?: string;
}

const sortWords = (key: string) =>
  /_at$/.test(key) ? ["newest first", "oldest first"] : key === "id" ? ["highest first", "lowest first"] : ["Z to A", "A to Z"];

/** Server-side grid: search, dropdown filters, sortable headers and pagination all round-trip to the API. */
export function DataGrid<T>(props: Props<T>) {
  const { columns, rows, total, pages, state, onChange, rowKey, onRowClick, filters = [], loading, error } = props;
  const set = (patch: Partial<GridState>) => onChange({ ...state, page: 1, ...patch });
  const sortBy = (key: string) => set({ sort: key, dir: state.sort === key && state.dir === "desc" ? "asc" : "desc" });
  const first = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
  const last = Math.min(total, state.page * state.pageSize);
  const filtered = Boolean(state.q) || Object.values(state.filters).some(Boolean);
  // On phones a long row of dropdowns would fill the screen, so they fold behind one button.
  const [showFilters, setShowFilters] = useState(false);
  const activeFilters = Object.values(state.filters).filter(Boolean).length;

  return (
    <div className="grid">
      <div className="grid-toolbar">
        {props.searchPlaceholder !== undefined && (
          <span className="input-icon grid-search">
            <Search size={16} />
            <input
              key={state.q ?? ""}
              type="search"
              className="input input-small"
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
          </span>
        )}
        {filters.length > 2 && (
          <button type="button" className="button button-small mobile-only filters-toggle" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>
            <SlidersHorizontal size={14} /> Filters{activeFilters ? ` (${activeFilters})` : ""}
          </button>
        )}
        {filters.map((f) => (
          <select
            key={f.key}
            className={filters.length > 2 && !showFilters ? "input input-small filter-chip folded" : "input input-small filter-chip"}
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
        {filtered && (
          <button type="button" className="button button-ghost button-small" onClick={() => set({ q: undefined, filters: {} })}>
            <X size={14} /> Clear
          </button>
        )}
        {columns.some((c) => c.sortable) && (
          // Phones show rows as cards without column headers, so sorting moves here.
          <select
            className="input input-small filter-chip mobile-only"
            aria-label="Sort by"
            value={`${state.sort ?? ""}:${state.dir ?? "desc"}`}
            onChange={(e) => {
              const [sort, dir] = e.target.value.split(":");
              set({ sort, dir: dir as "asc" | "desc" });
            }}
          >
            {columns
              .filter((c) => c.sortable)
              .flatMap((c) => [
                <option key={`${c.key}:desc`} value={`${c.key}:desc`}>
                  {c.header}: {sortWords(c.key)[0]}
                </option>,
                <option key={`${c.key}:asc`} value={`${c.key}:asc`}>
                  {c.header}: {sortWords(c.key)[1]}
                </option>,
              ])}
          </select>
        )}
        <div className="grid-toolbar-end">{props.toolbar}</div>
      </div>
      {Boolean(error) && (
        <p className="error-text grid-error" role="alert">
          {error instanceof Error ? error.message : "Could not load data."}
        </p>
      )}
      <div className="grid-scroll">
        <table className="table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.optional ? "col-optional" : undefined} style={c.width ? { width: c.width } : undefined} aria-sort={c.sortable && state.sort === c.key ? (state.dir === "asc" ? "ascending" : "descending") : undefined}>
                  {c.sortable ? (
                    <button type="button" className="sort-button" onClick={() => sortBy(c.key)}>
                      {c.header}
                      {state.sort === c.key ? state.dir === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} /> : <ArrowUpDown size={13} opacity={0.4} />}
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
                <tr
                  key={rowKey(row)}
                  className={onRowClick ? "row-link" : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onRowClick(row)) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-expanded={props.expanded ? Boolean(extra) : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} data-label={c.header} className={c.optional ? "col-optional" : undefined}>
                      {c.render(row)}
                    </td>
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
                  <EmptyState icon={<Inbox size={36} />} title={filtered ? "No matches" : "Nothing here yet"}>
                    {filtered ? "Try a different search or clear the filters." : props.emptyText}
                  </EmptyState>
                </td>
              </tr>
            )}
            {!rows &&
              loading &&
              Array.from({ length: 6 }, (_, i) => (
                <tr key={`sk-${i}`}>
                  {columns.map((c) => (
                    <td key={c.key} className={c.optional ? "col-optional" : undefined}>
                      <span className="skeleton" style={{ width: `${50 + ((i * 17 + c.key.length * 7) % 40)}%` }} />
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div className="grid-footer">
        <span>
          {total === 0 ? "No results" : `Showing ${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`}
        </span>
        <div className="grid-footer-pages">
          <select className="input input-small" aria-label="Rows per page" value={state.pageSize} onChange={(e) => set({ pageSize: Number(e.target.value) })}>
            {[10, 25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} per page
              </option>
            ))}
          </select>
          <button type="button" className="icon-button" aria-label="Previous page" disabled={state.page <= 1} onClick={() => onChange({ ...state, page: state.page - 1 })}>
            <ChevronLeft size={18} />
          </button>
          <span>
            Page {state.page} of {Math.max(pages, 1)}
          </span>
          <button type="button" className="icon-button" aria-label="Next page" disabled={state.page >= pages} onClick={() => onChange({ ...state, page: state.page + 1 })}>
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

export const gridQuery = (s: GridState) => ({ page: s.page, pageSize: s.pageSize, sort: s.sort, dir: s.dir, q: s.q, ...s.filters });
