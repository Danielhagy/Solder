/*
 * HeadersTab — KvRows plus an optional read-only virtual Authorization row
 * sourced from the bound Connection's auth scheme. The virtual row is
 * rendered for UX clarity ("you ARE getting auth") but NOT persisted to
 * node.config.headers — that keeps the editor's truth source clean and
 * means swapping Connections doesn't pollute the user's own headers.
 */
import KvRows from '../KvRows';
import type { HttpKvRow } from '../http.types';

const COMMON_HEADER_NAMES = [
  'Accept',
  'Accept-Encoding',
  'Accept-Language',
  'Cache-Control',
  'Content-Type',
  'Idempotency-Key',
  'If-Match',
  'If-None-Match',
  'Origin',
  'Prefer',
  'Referer',
  'User-Agent',
  'X-Correlation-Id',
  'X-Request-Id',
  'X-Trace-Id',
];

interface Props {
  nodeId: string;
  rows: HttpKvRow[];
  onChange: (next: HttpKvRow[]) => void;
  /** When set, the inherited auth Header (e.g. "Bearer ••• via HubSpot") is
   *  shown as a read-only top row. Pass `null` to suppress. */
  inheritedAuthSummary: string | null;
}

export default function HeadersTab({
  nodeId,
  rows,
  onChange,
  inheritedAuthSummary,
}: Props) {
  const managed = inheritedAuthSummary
    ? {
        enabled: true,
        key: 'Authorization',
        value: inheritedAuthSummary,
        managedReason:
          'Authorization is supplied by the bound Connection. Override on the Auth tab.',
      }
    : undefined;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-surface-500 dark:text-surface-400">
        Custom request headers. {inheritedAuthSummary
          ? 'Authorization is managed by the Connection above and shown for context.'
          : 'No Authorization is applied automatically — bind a Connection or set the Auth tab.'}
      </p>
      <KvRows
        nodeId={nodeId}
        rows={rows}
        onChange={onChange}
        keyPlaceholder="header"
        valuePlaceholder="value"
        keySuggestions={COMMON_HEADER_NAMES}
        managedFirstRow={managed}
        testIdBase="http-headers"
      />
    </div>
  );
}
