/*
 * MethodUrlBar — single-row request line, the most-used control in the
 * editor. Method as a color-coded Select on the left, ReferenceField URL
 * stretches the rest of the row, resolved-URL preview underneath (mono,
 * dim) shows where the request actually goes after Connection base_url +
 * params merge.
 */
import Select, { type SelectOption } from '@/components/Select';
import ReferenceField from '../ReferenceField';
import { HTTP_METHODS, type HttpMethod } from './http.types';

interface Props {
  nodeId: string;
  method: HttpMethod;
  onMethodChange: (m: HttpMethod) => void;
  url: string;
  onUrlChange: (url: string) => void;
  /** Pre-resolved URL — connection base + path + query. `null` when the
   *  user hasn't bound a Connection (the URL field IS the resolved URL). */
  resolvedUrl: string | null;
  /** Inline note when the URL is invalid (e.g. relative path with no
   *  Connection). Rendered under the resolved-URL line in rose. */
  errorHint?: string | null;
}

const METHOD_OPTIONS: SelectOption[] = HTTP_METHODS.map((m) => ({
  value: m,
  label: m,
  caption: methodCaption(m),
}));

function methodCaption(m: HttpMethod): string {
  if (m === 'GET') return 'read';
  if (m === 'POST') return 'create';
  if (m === 'PUT') return 'replace';
  if (m === 'PATCH') return 'update';
  if (m === 'DELETE') return 'remove';
  if (m === 'HEAD') return 'meta';
  return 'discover';
}

/** Tailwind classes for the method pill — colour-codes the verb so the user
 *  reads "this is a DELETE" before they read the URL. */
function methodPillColor(m: HttpMethod): string {
  switch (m) {
    case 'GET':
      return 'text-primary-500 dark:text-primary-300';
    case 'POST':
      return 'text-emerald-500 dark:text-emerald-300';
    case 'PUT':
      return 'text-forge-500 dark:text-forge-400';
    case 'PATCH':
      return 'text-violet-500 dark:text-violet-300';
    case 'DELETE':
      return 'text-rose-500 dark:text-rose-300';
    default:
      return 'text-surface-500 dark:text-surface-400';
  }
}

export default function MethodUrlBar({
  nodeId,
  method,
  onMethodChange,
  url,
  onUrlChange,
  resolvedUrl,
  errorHint,
}: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-stretch gap-2">
        <div className={`flex-shrink-0 font-mono font-semibold ${methodPillColor(method)}`}>
          <Select
            value={method}
            onChange={(v) => onMethodChange(v as HttpMethod)}
            options={METHOD_OPTIONS}
            size="md"
            ariaLabel="HTTP method"
            testid="http-method"
            width="120px"
          />
        </div>
        <div className="flex-1 min-w-0">
          <ReferenceField
            nodeId={nodeId}
            value={url}
            onChange={onUrlChange}
            placeholder="/v3/objects/contacts or https://api.example.com/..."
            singleLine
            ariaLabel="Request URL"
            testId="http-url"
          />
        </div>
      </div>
      {resolvedUrl && resolvedUrl !== url && (
        <div
          className="font-mono text-[10.5px] text-surface-500 dark:text-surface-500 pl-1 truncate"
          title={resolvedUrl}
          data-testid="http-resolved-url"
        >
          → {resolvedUrl}
        </div>
      )}
      {errorHint && (
        <div
          className="font-mono text-[10.5px] text-rose-500 dark:text-rose-400 pl-1"
          role="alert"
          data-testid="http-url-error"
        >
          {errorHint}
        </div>
      )}
    </div>
  );
}
