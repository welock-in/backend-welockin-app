/** {{variable}} interpolation — the ONLY place templates are filled. Missing vars
 *  render as an empty string (never "undefined"). */
const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

export function renderString(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(VAR_RE, (_, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Deep-render every string inside a JSON value (template `data` payloads). */
export function renderJson(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string") return renderString(value, vars);
  if (Array.isArray(value)) return value.map((v) => renderJson(v, vars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderJson(v, vars);
    }
    return out;
  }
  return value;
}
