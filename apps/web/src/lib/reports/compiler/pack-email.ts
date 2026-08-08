/**
 * Branded email for a scheduled report-pack delivery. The combined PDF rides as
 * an attachment; the body is a short, emerald-accented note listing what's inside.
 * Kept deliberately plain — this is an internal financial deliverable, not marketing.
 */

import type { CompiledPack } from './run';

export interface PackEmail {
  subject: string;
  html: string;
  text: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildPackEmail(pack: CompiledPack, packName: string, cadenceLabel: string): PackEmail {
  const entity = pack.meta.entityLabel;
  const generated = new Date(pack.meta.generatedAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const subject = `${packName} — ${entity} (${generated})`;

  const contentsText = pack.cover.contents
    .map((c, i) => `  ${i + 1}. ${c.report}${c.basisLabel ? ` · ${c.basisLabel}` : ''} — ${c.periodLabel}`)
    .join('\n');

  const contentsHtml = pack.cover.contents
    .map(
      (c) => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;">
          <div style="font-weight:600;color:#111827;font-size:14px;">${esc(c.report)}</div>
          <div style="color:#6b7280;font-size:12px;margin-top:2px;">${esc(c.periodLabel)}</div>
        </td>
        <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right;color:#9ca3af;font-size:12px;vertical-align:top;">
          ${c.basisLabel ? esc(c.basisLabel) : ''}
        </td>
      </tr>`,
    )
    .join('');

  const text = [
    `${packName}`,
    ``,
    `${entity}`,
    `Generated ${generated} · ${cadenceLabel} delivery`,
    ``,
    `This pack contains ${pack.sections.length} report section(s), attached as a single PDF:`,
    ``,
    contentsText,
    ``,
    `Every figure is computed directly from the general ledger.`,
  ].join('\n');

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
    <div style="border-left:4px solid #10b981;padding-left:14px;margin-bottom:20px;">
      <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#6b7280;">Financial Report Pack</div>
      <div style="font-size:20px;font-weight:700;margin-top:4px;">${esc(packName)}</div>
      <div style="font-size:14px;color:#374151;margin-top:2px;">${esc(entity)}</div>
    </div>
    <p style="font-size:14px;color:#374151;line-height:1.5;">
      Generated <strong>${esc(generated)}</strong> as part of your <strong>${esc(cadenceLabel.toLowerCase())}</strong> delivery.
      The complete pack (${pack.sections.length} report section${pack.sections.length === 1 ? '' : 's'}) is attached as a single PDF.
    </p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <tbody>${contentsHtml}</tbody>
    </table>
    <p style="font-size:12px;color:#9ca3af;line-height:1.5;">
      Every figure is computed directly from the general ledger — this is a book-of-record document.
    </p>
  </div>`;

  return { subject, html, text };
}
