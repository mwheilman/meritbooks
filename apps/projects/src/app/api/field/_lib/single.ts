/** One JSON command on its own route: the kind must match the route; the answer is the CommandResult. */
import { applyRaw, type FieldCtx } from './apply';
import type { CommandKind, CommandResult } from './contract';

export async function applySingle(ctx: FieldCtx, raw: unknown, kinds: ReadonlyArray<CommandKind>): Promise<CommandResult> {
  const kind = typeof raw === 'object' && raw !== null ? (raw as { kind?: unknown }).kind : undefined;
  if (typeof kind !== 'string' || !kinds.includes(kind as CommandKind)) {
    const id = typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string' ? String((raw as { id: string }).id).slice(0, 64) : '';
    return { id, kind: typeof kind === 'string' ? kind.slice(0, 40) : 'unknown', outcome: 'rejected', code: 'WRONG_ROUTE', reason: `Send ${kinds.join(' or ')} commands here.` };
  }
  return applyRaw(ctx, raw);
}
