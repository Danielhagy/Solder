/*
 * BodyTab — mode-aware body editor.
 *
 *   none     → no field; explains GET-style "no body sent"
 *   json     → textarea, blur-parses, surfaces a visible error pip on bad
 *              JSON (the old editor's silent-drop was a real footgun)
 *   form     → KvRows, sent as application/x-www-form-urlencoded
 *   template → ReferenceField multi-line, raw text with `{{$.…}}` tokens
 *   graphql  → query (template) + variables (JSON)
 *   raw      → plain textarea + content-type Select
 */
import { useEffect, useState } from 'react';
import Select from '@/components/Select';
import ReferenceField from '../../ReferenceField';
import KvRows from '../KvRows';
import type { HttpBody, HttpBodyMode } from '../http.types';

const MODE_OPTIONS = [
  { value: 'none', label: 'None', caption: 'no body' },
  { value: 'json', label: 'JSON', caption: 'application/json' },
  { value: 'form', label: 'Form', caption: 'x-www-form-urlencoded' },
  { value: 'template', label: 'Template', caption: 'JSON with refs' },
  { value: 'graphql', label: 'GraphQL', caption: 'query + variables' },
  { value: 'raw', label: 'Raw', caption: 'custom content-type' },
];

const COMMON_CONTENT_TYPES = [
  'application/json',
  'application/xml',
  'text/plain',
  'text/html',
  'application/x-www-form-urlencoded',
];

interface Props {
  nodeId: string;
  body: HttpBody;
  onChange: (next: HttpBody) => void;
}

export default function BodyTab({ nodeId, body, onChange }: Props) {
  function setMode(next: HttpBodyMode) {
    if (next === body.mode) return;
    // Smart default content-type per mode.
    let contentType = body.contentType;
    if (next === 'json' || next === 'template') contentType = 'application/json';
    else if (next === 'form') contentType = 'application/x-www-form-urlencoded';
    else if (next === 'graphql') contentType = 'application/json';
    else if (next === 'none') contentType = null;
    onChange({ ...body, mode: next, contentType });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-surface-500 dark:text-surface-400">
          mode
        </span>
        <Select
          value={body.mode}
          onChange={(v) => setMode(v as HttpBodyMode)}
          options={MODE_OPTIONS}
          size="sm"
          ariaLabel="Body mode"
          testid="http-body-mode"
          width="240px"
        />
      </div>

      {body.mode === 'none' && (
        <p className="text-[11px] text-surface-500 dark:text-surface-400 italic">
          No request body will be sent.
        </p>
      )}

      {body.mode === 'json' && (
        <JsonBodyField
          value={body.json}
          onChange={(json) => onChange({ ...body, json })}
        />
      )}

      {body.mode === 'form' && (
        <KvRows
          nodeId={nodeId}
          rows={body.form ?? []}
          onChange={(form) => onChange({ ...body, form })}
          keyPlaceholder="field"
          valuePlaceholder="value"
          testIdBase="http-body-form"
        />
      )}

      {body.mode === 'template' && (
        <ReferenceField
          nodeId={nodeId}
          value={body.text ?? ''}
          onChange={(text) => onChange({ ...body, text })}
          placeholder={'{"id": {{$.steps.X.output.id}}, "name": "{{$.user.name}}"}'}
          rows={6}
          ariaLabel="Body template"
          testId="http-body-template"
        />
      )}

      {body.mode === 'graphql' && (
        <div className="flex flex-col gap-2">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-surface-500 dark:text-surface-400 mb-1">
              query
            </div>
            <ReferenceField
              nodeId={nodeId}
              value={body.text ?? ''}
              onChange={(text) => onChange({ ...body, text })}
              placeholder={'query GetUser($id: ID!) { user(id: $id) { name } }'}
              rows={6}
              ariaLabel="GraphQL query"
              testId="http-body-graphql-query"
            />
          </div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-surface-500 dark:text-surface-400 mb-1">
              variables (JSON)
            </div>
            <JsonBodyField
              value={body.graphqlVariables}
              onChange={(graphqlVariables) => onChange({ ...body, graphqlVariables })}
              placeholder={'{"id": "{{$.trigger.userId}}"}'}
              testId="http-body-graphql-vars"
            />
          </div>
        </div>
      )}

      {body.mode === 'raw' && (
        <div className="flex flex-col gap-2">
          <textarea
            value={body.text ?? ''}
            onChange={(e) => onChange({ ...body, text: e.currentTarget.value })}
            rows={6}
            spellCheck={false}
            className="input w-full font-mono text-xs"
            placeholder="raw request body"
            data-testid="http-body-raw"
          />
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-surface-500 dark:text-surface-400">
              content-type
            </span>
            <input
              type="text"
              value={body.contentType ?? ''}
              onChange={(e) => onChange({ ...body, contentType: e.currentTarget.value || null })}
              list="http-body-raw-content-types"
              placeholder="text/plain"
              className="input flex-1 font-mono text-xs py-1"
              data-testid="http-body-raw-content-type"
            />
            <datalist id="http-body-raw-content-types">
              {COMMON_CONTENT_TYPES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
        </div>
      )}
    </div>
  );
}

/** JSON editor with visible parse-error indicator and an "uncommitted edit"
 *  state so users see when their typed text doesn't match the stored value. */
function JsonBodyField({
  value,
  onChange,
  placeholder = '{"key": "value"}',
  testId = 'http-body-json',
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  placeholder?: string;
  testId?: string;
}) {
  const initialText =
    value === undefined || value === null
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value, null, 2);
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Sync external value changes (e.g. mode toggled, migration applied) by
  // re-keying. Lightweight check — only resets text when the stored shape
  // genuinely changes from outside.
  useEffect(() => {
    const next =
      value === undefined || value === null
        ? ''
        : typeof value === 'string'
          ? value
          : JSON.stringify(value, null, 2);
    if (!dirty && next !== text) {
      setText(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function commit() {
    if (!text.trim()) {
      setError(null);
      setDirty(false);
      onChange(null);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      setError(null);
      setDirty(false);
      onChange(parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value);
          setDirty(true);
          if (error) setError(null);
        }}
        onBlur={commit}
        rows={6}
        spellCheck={false}
        placeholder={placeholder}
        data-testid={testId}
        className={[
          'input w-full font-mono text-xs',
          error ? 'ring-1 ring-rose-500' : '',
        ].join(' ')}
      />
      {error && (
        <div
          className="font-mono text-[10.5px] text-rose-500 dark:text-rose-400"
          role="alert"
        >
          ⚠ {error}
        </div>
      )}
      {dirty && !error && (
        <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-surface-500 dark:text-surface-400">
          unsaved — click out to commit
        </div>
      )}
    </div>
  );
}
