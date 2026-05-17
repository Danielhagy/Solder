/*
 * AuthTab — per-request auth override.
 *
 * Default mode is `inherit` — the bound Connection's auth scheme is applied.
 * Switching to a specific scheme (bearer/basic/api_key_*) reveals the
 * relevant fields, all of which accept `{{$.…}}` refs so the user can pull
 * tokens out of upstream nodes.
 */
import Select from '@/components/Select';
import ReferenceField from '../../ReferenceField';
import type { HttpAuth, HttpAuthOverrideMode } from '../http.types';

const MODE_OPTIONS = [
  {
    value: 'inherit',
    label: 'Inherit from Connection',
    caption: 'use bound Connection auth',
  },
  {
    value: 'none',
    label: 'None',
    caption: 'send no Authorization',
  },
  { value: 'bearer', label: 'Bearer token', caption: 'Authorization: Bearer …' },
  { value: 'basic', label: 'Basic', caption: 'username + password' },
  {
    value: 'api_key_header',
    label: 'API key (header)',
    caption: 'custom header',
  },
  {
    value: 'api_key_query',
    label: 'API key (query)',
    caption: 'query string param',
  },
];

interface Props {
  nodeId: string;
  auth: HttpAuth;
  /** Best-effort summary of what `inherit` resolves to (e.g. "Bearer ••• via
   *  HubSpot prod"). Rendered as a subtitle when mode === 'inherit'. */
  inheritedSummary: string | null;
  onChange: (next: HttpAuth) => void;
}

export default function AuthTab({ nodeId, auth, inheritedSummary, onChange }: Props) {
  function setMode(mode: HttpAuthOverrideMode) {
    onChange({ ...auth, mode });
  }
  function patch(partial: Partial<HttpAuth>) {
    onChange({ ...auth, ...partial });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-surface-500 dark:text-surface-400">
          mode
        </span>
        <Select
          value={auth.mode}
          onChange={(v) => setMode(v as HttpAuthOverrideMode)}
          options={MODE_OPTIONS}
          size="sm"
          ariaLabel="Auth mode"
          testid="http-auth-mode"
          width="260px"
        />
      </div>

      {auth.mode === 'inherit' && (
        <p className="text-[11px] text-surface-500 dark:text-surface-400">
          {inheritedSummary
            ? `Using ${inheritedSummary}. Switch mode to override.`
            : 'No Connection bound — no auth will be applied. Bind a Connection above or pick an explicit scheme here.'}
        </p>
      )}

      {auth.mode === 'none' && (
        <p className="text-[11px] text-surface-500 dark:text-surface-400">
          The request is sent without an Authorization header even if a
          Connection is bound.
        </p>
      )}

      {auth.mode === 'bearer' && (
        <Field label="Token">
          <ReferenceField
            nodeId={nodeId}
            value={auth.bearerToken ?? ''}
            onChange={(bearerToken) => patch({ bearerToken })}
            placeholder="sk-…"
            singleLine
            ariaLabel="Bearer token"
            testId="http-auth-bearer-token"
          />
        </Field>
      )}

      {auth.mode === 'basic' && (
        <>
          <Field label="Username">
            <ReferenceField
              nodeId={nodeId}
              value={auth.basicUsername ?? ''}
              onChange={(basicUsername) => patch({ basicUsername })}
              placeholder="user"
              singleLine
              ariaLabel="Basic auth username"
              testId="http-auth-basic-username"
            />
          </Field>
          <Field label="Password">
            <ReferenceField
              nodeId={nodeId}
              value={auth.basicPassword ?? ''}
              onChange={(basicPassword) => patch({ basicPassword })}
              placeholder="password"
              singleLine
              ariaLabel="Basic auth password"
              testId="http-auth-basic-password"
            />
          </Field>
        </>
      )}

      {(auth.mode === 'api_key_header' || auth.mode === 'api_key_query') && (
        <>
          <Field label="Name">
            <input
              type="text"
              value={auth.apiKeyName ?? ''}
              onChange={(e) => patch({ apiKeyName: e.currentTarget.value })}
              placeholder={auth.mode === 'api_key_header' ? 'X-API-Key' : 'api_key'}
              className="input w-full font-mono text-xs py-1"
              data-testid="http-auth-api-key-name"
            />
          </Field>
          <Field label="Value">
            <ReferenceField
              nodeId={nodeId}
              value={auth.apiKeyValue ?? ''}
              onChange={(apiKeyValue) => patch({ apiKeyValue })}
              placeholder="secret value"
              singleLine
              ariaLabel="API key value"
              testId="http-auth-api-key-value"
            />
          </Field>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-surface-500 dark:text-surface-400 mb-1">
        {label}
      </div>
      {children}
    </label>
  );
}
