import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { postJournalEntrySchema, type PostJournalEntryInput } from '@/lib/validations/gl';
import { postJournalEntry } from '@/lib/services/gl-posting';

export const POST = apiHandler(
  postJournalEntrySchema,
  async (body: PostJournalEntryInput, ctx) => {
    const result = await postJournalEntry(ctx.supabase, {
      org_id: ctx.orgId ?? '',
      location_id: body.location_id,
      entry_date: body.entry_date,
      entry_type: body.entry_type,
      memo: body.memo,
      source_module: body.source_module ?? 'MANUAL',
      source_id: body.source_id,
      created_by: ctx.userId,
      lines: body.lines,
    });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error, code: 'POST_FAILED' },
        { status: 400 }
      );
    }

    return NextResponse.json(result, { status: 201 });
  }
);
