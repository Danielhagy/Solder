import { useEffect, useState, type ChangeEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type OpenAPISpec } from '@/api/client';
import { SpecRowSkeleton } from '@/components/Skeleton';
import PageHeader from '@/components/PageHeader';
import EmptyFrame from '@/components/EmptyFrame';

export default function Docs() {
  const [specs, setSpecs] = useState<OpenAPISpec[]>([]);
  const [selected, setSelected] = useState<OpenAPISpec | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showDialog, setShowDialog] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [uploadUrl, setUploadUrl] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  async function loadSpecs() {
    setLoading(true);
    try {
      const data = await api.listOpenAPISpecs();
      setSpecs(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load specs');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSpecs();
  }, []);

  useEffect(() => {
    if (!showDialog) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowDialog(false);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showDialog]);

  async function handleFetch() {
    if (!uploadUrl || !uploadName) return;
    setUploading(true);
    try {
      await api.fetchOpenAPISpec(uploadUrl, uploadName);
      await loadSpecs();
      setShowDialog(false);
      setUploadName('');
      setUploadUrl('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch spec');
    } finally {
      setUploading(false);
    }
  }

  async function handleUpload() {
    if (!uploadFile || !uploadName) return;
    setUploading(true);
    try {
      await api.uploadOpenAPISpec(uploadName, uploadFile);
      await loadSpecs();
      setShowDialog(false);
      setUploadName('');
      setUploadFile(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to upload spec');
    } finally {
      setUploading(false);
    }
  }

  async function deleteSpec(id: string) {
    if (!confirm('Delete this specification?')) return;
    try {
      await api.deleteOpenAPISpec(id);
      if (selected?.id === id) setSelected(null);
      await loadSpecs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete spec');
    }
  }

  function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    setUploadFile(e.target.files?.[0] || null);
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <PageHeader
        eyebrow="api specifications"
        title="API Documentation"
        description="OpenAPI specs become first-class signal: the Builder's API Call node uses them to suggest endpoints, params, and shapes."
        action={
          <button type="button" className="btn btn-primary" onClick={() => setShowDialog(true)}>
            Add API
          </button>
        }
      />

      {error && (
        <div className="card p-4 bg-red-50 text-red-600 mb-6 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800/50">
          {error}
          <button type="button" className="ml-2 underline" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6" data-testid="specs-skeleton">
          <div className="space-y-3">
            <SpecRowSkeleton />
            <SpecRowSkeleton />
            <SpecRowSkeleton />
          </div>
          <div className="card p-12 text-center text-surface-400 dark:text-surface-500 min-w-0 min-h-[60vh] flex items-center justify-center">
            Loading…
          </div>
        </div>
      ) : specs.length === 0 ? (
        <EmptyFrame
          label="state · empty"
          glyph="◇"
          title="No API specifications"
          description="Upload an OpenAPI spec or fetch one from a URL. Solder uses the shape of your API to generate nodes."
          action={
            <button type="button" className="btn btn-primary" onClick={() => setShowDialog(true)}>
              Add your first API
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
          <div className="space-y-3">
            {specs.map((spec) => (
              <div
                key={spec.id}
                role="button"
                tabIndex={0}
                className={`card p-4 cursor-pointer hover:shadow-md transition-shadow ${
                  selected?.id === spec.id ? 'ring-2 ring-primary-500' : ''
                }`}
                onClick={() => setSelected(spec)}
                onKeyDown={(e) => e.key === 'Enter' && setSelected(spec)}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-medium dark:text-surface-50">{spec.name}</h3>
                  <button
                    type="button"
                    aria-label="Delete spec"
                    className="text-surface-400 hover:text-red-500 dark:text-surface-500 dark:hover:text-red-400"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteSpec(spec.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
                <p className="text-sm text-surface-500 mt-1 dark:text-surface-400">v{spec.version}</p>
              </div>
            ))}
          </div>

          <div className="min-w-0">
            {selected ? (
              <div className="card">
                <div className="p-4 border-b border-surface-200 dark:border-surface-800">
                  <h2 className="text-xl font-semibold dark:text-surface-50">{selected.name}</h2>
                  <p className="text-surface-500 text-sm dark:text-surface-400">
                    Version {selected.version}
                    {selected.url && (
                      <>
                        {' · '}
                        <a
                          href={selected.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary-600 hover:underline"
                        >
                          Source
                        </a>
                      </>
                    )}
                  </p>
                </div>
                <div className="p-6">
                  {selected.parsed_markdown ? (
                    <div className="solder-md max-w-none dark:text-surface-200">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {selected.parsed_markdown}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <pre className="text-sm overflow-auto dark:text-surface-200 whitespace-pre-wrap font-mono">
                      {JSON.stringify(selected.spec_json, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            ) : (
              <EmptyFrame
                label="state · idle"
                glyph="·"
                compact
                fill
                title="Pick a specification"
                description="Choose a spec on the left to read its endpoints, schemas, and examples."
              />
            )}
          </div>
        </div>
      )}

      <AnimatePresence>
        {showDialog && (
          <motion.div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 dark:bg-black/70"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <motion.div
              className="card p-6 w-full max-w-md dark:text-surface-100"
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <h2 className="text-lg font-semibold mb-4 dark:text-surface-50">Add API Specification</h2>

              <div className="space-y-4">
                <label className="block">
                  <span className="block text-sm font-medium text-surface-700 mb-1 dark:text-surface-200">Name</span>
                  <input
                    type="text"
                    value={uploadName}
                    onChange={(e) => setUploadName(e.target.value)}
                    className="input w-full"
                    placeholder="My API"
                  />
                </label>

                <div className="border-t border-surface-200 pt-4 dark:border-surface-800">
                  <p className="text-sm font-medium text-surface-700 mb-2 dark:text-surface-200">Fetch from URL</p>
                  <input
                    type="url"
                    value={uploadUrl}
                    onChange={(e) => setUploadUrl(e.target.value)}
                    className="input w-full"
                    placeholder="https://api.example.com/openapi.json"
                  />
                  <button
                    type="button"
                    className="btn btn-primary w-full mt-2"
                    onClick={handleFetch}
                    disabled={uploading || !uploadUrl || !uploadName}
                  >
                    {uploading ? 'Fetching...' : 'Fetch'}
                  </button>
                </div>

                <div className="border-t border-surface-200 pt-4 dark:border-surface-800">
                  <p className="text-sm font-medium text-surface-700 mb-2 dark:text-surface-200">Or upload file</p>
                  <input
                    type="file"
                    accept=".json,.yaml,.yml"
                    onChange={handleFileSelect}
                    className="w-full text-sm dark:text-surface-300"
                  />
                  <button
                    type="button"
                    className="btn btn-secondary w-full mt-2"
                    onClick={handleUpload}
                    disabled={uploading || !uploadFile || !uploadName}
                  >
                    {uploading ? 'Uploading...' : 'Upload'}
                  </button>
                </div>
              </div>

              <div className="flex justify-end mt-6">
                <button type="button" className="btn btn-ghost" onClick={() => setShowDialog(false)}>
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
