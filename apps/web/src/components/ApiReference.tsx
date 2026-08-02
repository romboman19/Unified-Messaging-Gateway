import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Lock, Search } from 'lucide-react';
import { api } from '../hooks/useAuth';

/** Only the slice of OpenAPI this reference renders. */
interface OpenApiDoc {
  info?: { title?: string; description?: string; version?: string };
  paths?: Record<string, Record<string, Operation>>;
}

interface Operation {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  security?: unknown[];
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: { type?: string };
  }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: { $ref?: string } }>;
  };
  responses?: Record<string, { description?: string }>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const METHOD_COLOR: Record<string, string> = {
  get: 'bg-sky-100 text-sky-800',
  post: 'bg-emerald-100 text-emerald-800',
  put: 'bg-amber-100 text-amber-800',
  patch: 'bg-amber-100 text-amber-800',
  delete: 'bg-red-100 text-red-700',
};

interface Endpoint {
  method: string;
  path: string;
  op: Operation;
  tag: string;
}

/**
 * Renders the API surface from the server's own OpenAPI document.
 *
 * Reading the live spec rather than a hand-written list means this cannot
 * drift: a route that exists is listed, a route that was removed disappears.
 * The heavyweight Swagger UI bundle is deliberately avoided — the admin needs
 * to see what exists and how to call it, not a request playground, and the
 * app stays free of a large third-party dependency.
 */
export function ApiReference() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const spec = useQuery({
    queryKey: ['openapi'],
    queryFn: async () => (await api.get<OpenApiDoc>('/openapi')).data,
    staleTime: 5 * 60 * 1000,
  });

  const endpoints = useMemo<Endpoint[]>(() => {
    const paths = spec.data?.paths ?? {};
    const out: Endpoint[] = [];
    for (const [path, item] of Object.entries(paths)) {
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op) continue;
        // Nest only emits tags where a controller declares @ApiTags, and this
        // API declares none — everything would land in one pile. Group on the
        // resource instead, which is the segment after the global `/api/v1`
        // prefix the spec already carries.
        const segments = path.split('/').filter(Boolean);
        const resource =
          segments[0] === 'api' && /^v\d+$/.test(segments[1] ?? '') ? segments[2] : segments[0];
        out.push({ method, path, op, tag: op.tags?.[0] ?? resource ?? 'інше' });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  }, [spec.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return endpoints;
    return endpoints.filter(
      (e) =>
        e.path.toLowerCase().includes(q) ||
        e.method.includes(q) ||
        (e.op.summary ?? '').toLowerCase().includes(q) ||
        e.tag.toLowerCase().includes(q),
    );
  }, [endpoints, query]);

  const byTag = useMemo(() => {
    const groups = new Map<string, Endpoint[]>();
    for (const e of filtered) {
      const list = groups.get(e.tag) ?? [];
      list.push(e);
      groups.set(e.tag, list);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  if (spec.isLoading) {
    return <div className="rounded-lg bg-white p-6 text-sm text-slate-500 shadow">Завантаження…</div>;
  }
  if (spec.isError) {
    return (
      <div className="rounded-lg bg-white p-6 text-sm text-red-600 shadow">
        Не вдалося завантажити опис API.
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-white shadow">
      <div className="border-b p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-semibold">Довідник API</h3>
            <p className="text-sm text-slate-500">
              Усі методи сервера. Базовий шлях — <code className="rounded bg-slate-100 px-1">/api/v1</code>.
              Автентифікація: cookie-сесія адміністратора або заголовок{' '}
              <code className="rounded bg-slate-100 px-1">Authorization: Bearer &lt;токен&gt;</code>.
            </p>
          </div>
          <span className="text-xs text-slate-400">{endpoints.length} методів</span>
        </div>
        <div className="mt-3 flex items-center gap-2 rounded border px-2">
          <Search size={16} className="text-slate-400" />
          <input
            className="w-full p-2 text-sm outline-none"
            placeholder="Пошук за шляхом, методом або описом…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {byTag.length === 0 && (
        <div className="p-6 text-sm text-slate-500">Нічого не знайдено.</div>
      )}

      {byTag.map(([tag, list]) => (
        <div key={tag} className="border-b last:border-b-0">
          <div className="bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {tag} <span className="font-normal normal-case text-slate-400">({list.length})</span>
          </div>
          {list.map((e) => {
            const key = `${e.method} ${e.path}`;
            const isOpen = !!open[key];
            const params = e.op.parameters ?? [];
            const hasBody = !!e.op.requestBody;
            return (
              <div key={key} className="border-t first:border-t-0">
                <button
                  onClick={() => setOpen((p) => ({ ...p, [key]: !p[key] }))}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-slate-50"
                >
                  {isOpen ? (
                    <ChevronDown size={14} className="shrink-0 text-slate-400" />
                  ) : (
                    <ChevronRight size={14} className="shrink-0 text-slate-400" />
                  )}
                  <span
                    className={`w-16 shrink-0 rounded px-2 py-0.5 text-center text-xs font-semibold uppercase ${
                      METHOD_COLOR[e.method] ?? 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {e.method}
                  </span>
                  <code className="min-w-0 flex-1 truncate text-sm">{e.path}</code>
                  {e.op.summary && (
                    <span className="hidden truncate text-xs text-slate-500 md:block md:max-w-xs">
                      {e.op.summary}
                    </span>
                  )}
                </button>

                {isOpen && (
                  <div className="space-y-3 bg-slate-50 px-4 py-3 pl-11 text-sm">
                    {(e.op.summary || e.op.description) && (
                      <p className="text-slate-600">{e.op.description || e.op.summary}</p>
                    )}

                    {params.length > 0 && (
                      <div>
                        <div className="mb-1 text-xs font-semibold text-slate-500">Параметри</div>
                        <ul className="space-y-1">
                          {params.map((p) => (
                            <li key={`${p.in}-${p.name}`} className="text-xs">
                              <code className="rounded bg-white px-1">{p.name}</code>{' '}
                              <span className="text-slate-400">
                                ({p.in}
                                {p.schema?.type ? `, ${p.schema.type}` : ''})
                              </span>
                              {p.required && <span className="ml-1 text-red-600">обовʼязковий</span>}
                              {p.description && (
                                <span className="ml-1 text-slate-500">— {p.description}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {hasBody && (
                      <div className="text-xs text-slate-500">
                        Приймає тіло запиту у форматі JSON
                        {e.op.requestBody?.required ? ' (обовʼязкове)' : ''}.
                      </div>
                    )}

                    {e.op.responses && (
                      <div>
                        <div className="mb-1 text-xs font-semibold text-slate-500">Відповіді</div>
                        <ul className="flex flex-wrap gap-2">
                          {Object.entries(e.op.responses).map(([code, r]) => (
                            <li key={code} className="rounded bg-white px-2 py-0.5 text-xs">
                              <span className="font-semibold">{code}</span>
                              {r.description ? (
                                <span className="text-slate-500"> — {r.description}</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="flex items-center gap-1 text-xs text-slate-400">
                      <Lock size={12} />
                      Потрібна автентифікація (сесія або Bearer-токен)
                    </div>

                    <pre className="overflow-x-auto rounded bg-slate-800 px-3 py-2 text-xs text-slate-100">
{`curl -X ${e.method.toUpperCase()} "http://<хост>:8083${e.path}" \\
  -H "Authorization: Bearer <токен>"${hasBody ? ' \\\n  -H "Content-Type: application/json" \\\n  -d \'{}\'' : ''}`}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
