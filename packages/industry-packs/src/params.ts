/** Pack params: defaults and a strict Zod schema built from a manifest's params spec. */
import { z } from 'zod';
import type { PackManifest } from './types';

export type ParamValue = boolean | number | string;

export function defaultParams(manifest: PackManifest): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const key of Object.keys(manifest.params).sort()) out[key] = manifest.params[key].default;
  return out;
}

/** Strict schema: unknown keys fail, every value is bounded by its spec. All keys optional. */
export function paramsSchemaFor(manifest: PackManifest) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, p] of Object.entries(manifest.params)) {
    let s: z.ZodTypeAny;
    switch (p.type) {
      case 'bool':
        s = z.boolean();
        break;
      case 'percent':
        s = z.number().min(p.min ?? 0).max(p.max ?? 1);
        break;
      case 'integer': {
        let n = z.number().int();
        if (p.min !== undefined) n = n.min(p.min);
        if (p.max !== undefined) n = n.max(p.max);
        s = n;
        break;
      }
      case 'enum':
        s = z.enum((p.options ?? []) as [string, ...string[]]);
        break;
    }
    shape[key] = s.optional();
  }
  return z.object(shape).strict();
}

export interface ParamCheck {
  ok: boolean;
  params: Record<string, ParamValue>;
  issues: string[];
}

/** Validate caller params; the result always carries the full set (defaults filled). */
export function checkParams(manifest: PackManifest, provided: Record<string, unknown> | undefined): ParamCheck {
  const base = defaultParams(manifest);
  if (provided === undefined) return { ok: true, params: base, issues: [] };
  const r = paramsSchemaFor(manifest).safeParse(provided);
  if (!r.success) {
    return {
      ok: false,
      params: base,
      issues: r.error.issues.map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`),
    };
  }
  const merged: Record<string, ParamValue> = { ...base };
  for (const [k, v] of Object.entries(r.data)) if (v !== undefined) merged[k] = v as ParamValue;
  return { ok: true, params: merged, issues: [] };
}
