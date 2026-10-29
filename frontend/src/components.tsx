import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { ApiError } from "./api";

export function Icon({
  name,
  size = 20,
}: {
  name:
    | "box"
    | "grid"
    | "orders"
    | "arrow"
    | "search"
    | "plus"
    | "close"
    | "history"
    | "edit"
    | "trash"
    | "check"
    | "alert";
  size?: number;
}) {
  const paths: Record<typeof name, ReactNode> = {
    box: (
      <>
        <path d="m12 3 9 5v8l-9 5-9-5V8l9-5Z" />
        <path d="m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    orders: (
      <>
        <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" />
        <path d="M9 7h6M9 11h6M9 15h3" />
      </>
    ),
    arrow: (
      <>
        <path d="M7 20V4m-4 4 4-4 4 4M17 4v16m-4-4 4 4 4-4" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    history: (
      <>
        <path d="M3 11a9 9 0 1 1 2 7M3 4v7h7" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    edit: (
      <>
        <path d="m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    alert: (
      <>
        <path d="m12 3 10 18H2L12 3Z" />
        <path d="M12 9v5M12 17v.1" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  const detail = error instanceof ApiError ? error.detail : null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="error-message" role="alert">
      <Icon name="alert" />
      <div>
        <strong>{message}</strong>
        {detail?.available !== undefined && (
          <p>
            {detail.sku ? `${detail.sku}: ` : ""}
            {detail.available} units available.
          </p>
        )}
        {detail?.fields &&
          Object.entries(detail.fields).map(([key, value]) => (
            <p key={key}>{value}</p>
          ))}
      </div>
    </div>
  );
}
export function Modal({
  title,
  subtitle,
  onClose,
  busy = false,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      aria-labelledby="modal-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="modal-heading">
        <div>
          <h2 id="modal-title">{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          className="icon-button"
          aria-label="Close dialog"
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name="box" size={28} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Pagination({
  page,
  total,
  limit = 10,
  onChange,
}: {
  page: number;
  total: number;
  limit?: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="pagination">
      <span>
        {total === 0
          ? "No results"
          : `${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total} results`}
      </span>
      <div>
        <button
          type="button"
          className="button secondary small"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          Previous
        </button>
        <span>
          Page {page} of {pages}
        </span>
        <button
          type="button"
          className="button secondary small"
          disabled={page >= pages}
          onClick={() => onChange(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
export function LoadingRows({ columns }: { columns: number }) {
  return (
    <tbody aria-label="Loading results">
      {Array.from({ length: 6 }, (_, i) => (
        <tr key={i}>
          {Array.from({ length: columns }, (_, j) => (
            <td key={j}>
              <span className="skeleton" />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}
