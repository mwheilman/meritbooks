/**
 * AI Journal-Entry composer (Master Document II.5 — the NL "front door").
 *
 * Turns a plain-English description into a PROPOSED balanced journal entry using
 * only the org's real chart of accounts. Advisory only: it proposes, a human
 * approves. It never posts. It also predicts balance-sheet treatment
 * (capex / prepaid / deferred revenue) and asks one clarifying question when the
 * economic substance is genuinely ambiguous rather than guessing silently.
 *
 * Mirrors the existing bill-parser Claude integration (same endpoint, version,
 * model, JSON-out contract).
 */

export interface ComposerAccount {
  account_number: string;
  name: string;
  account_type: string;
  account_sub_type: string;
}

export type PredictionType = 'NONE' | 'CAPEX' | 'PREPAID' | 'DEFERRED_REVENUE';

export interface ComposedLine {
  account_number: string;
  debit_cents: number;
  credit_cents: number;
  memo: string | null;
}

export interface ComposerProposal {
  memo: string;
  lines: ComposedLine[];
  balanced: boolean;
  totalDebitCents: number;
  totalCreditCents: number;
  prediction: { type: PredictionType; rationale: string | null };
  confidence: number;
  clarifyingQuestion: string | null;
  notes: string | null;
}

export interface ComposerResult {
  success: boolean;
  error?: string;
  proposal?: ComposerProposal;
  tokensInput?: number;
  tokensOutput?: number;
  latencyMs?: number;
}

const MODEL = 'claude-sonnet-4-20250514';

function buildPrompt(description: string, accounts: ComposerAccount[], today: string, companyName?: string): string {
  // Keep the account list compact but complete — number, name, type/sub-type.
  const coa = accounts
    .map((a) => `${a.account_number}\t${a.name}\t(${a.account_type}/${a.account_sub_type})`)
    .join('\n');

  return `You are a senior accountant drafting a journal entry for ${companyName ? `the company "${companyName}"` : 'a company'}. Today is ${today}.

Convert the user's description into a balanced double-entry journal entry using ONLY the accounts in the chart below. Follow GAAP and the firm's prediction rules.

CHART OF ACCOUNTS (account_number<TAB>name<TAB>(type/sub_type)):
${coa}

USER DESCRIPTION:
"""${description}"""

RULES:
- Use ONLY account numbers that appear in the chart above. Never invent a number.
- All amounts are INTEGER CENTS (e.g., $1,234.56 -> 123456). No decimals, no floats.
- Each line has either a debit OR a credit (one of them > 0, the other 0). Total debits MUST equal total credits.
- Prefer the most specific appropriate account.
- PREDICTION — classify the economic substance and flag balance-sheet treatment when relevant:
  - CAPEX: an asset with useful life > 1 year and a material cost -> propose the asset account, not an expense.
  - PREPAID: payment covers a future period (annual insurance/software, prepaid rent, retainers) -> propose a prepaid asset, not an immediate expense.
  - DEFERRED_REVENUE: a customer prepayment/deposit -> propose a liability, not revenue.
  - Otherwise NONE.
- JUDGMENT: do NOT pattern-match away real economic substance. Example: a customer paying part of the price while the company funds the rest as prepaid advertising is NOT a price concession — book full revenue plus the company-funded portion as a prepaid asset. If the substance is genuinely ambiguous, set "clarifyingQuestion" to ONE specific question and still return your best-guess balanced lines.
- This is ADVISORY. A human will review, edit, and approve. Be conservative and explain non-obvious choices in "notes".

Respond with ONLY a JSON object, no markdown, no prose:
{
  "memo": "short entry description",
  "lines": [
    { "account_number": "1000", "debit_cents": 0, "credit_cents": 0, "memo": "line note or null" }
  ],
  "prediction": { "type": "NONE|CAPEX|PREPAID|DEFERRED_REVENUE", "rationale": "why, or null" },
  "confidence": 0.0,
  "clarifyingQuestion": "one question, or null",
  "notes": "non-obvious judgment calls, or null"
}`;
}

export async function composeJournalEntry(
  description: string,
  accounts: ComposerAccount[],
  apiKey: string,
  companyName?: string
): Promise<ComposerResult> {
  if (!description.trim()) return { success: false, error: 'Description is empty' };
  if (accounts.length === 0) return { success: false, error: 'No chart of accounts available — seed the COA first' };

  const today = new Date().toISOString().split('T')[0];
  const prompt = buildPrompt(description, accounts, today, companyName);
  const start = Date.now();

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('[je-composer] Claude API error:', response.status, errBody);
      return { success: false, error: `Claude API returned ${response.status}` };
    }

    const result = await response.json();
    const textContent = result.content?.find((c: { type: string }) => c.type === 'text');
    if (!textContent?.text) return { success: false, error: 'Claude returned an empty response' };

    const jsonStr = textContent.text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      console.error('[je-composer] Failed to parse JSON:', jsonStr.slice(0, 500));
      return { success: false, error: 'Could not parse the AI response' };
    }

    const rawLines = (parsed.lines as Array<Record<string, unknown>>) ?? [];
    const lines: ComposedLine[] = rawLines.map((l) => ({
      account_number: String(l.account_number ?? ''),
      debit_cents: Math.max(0, Math.round(Number(l.debit_cents ?? 0))),
      credit_cents: Math.max(0, Math.round(Number(l.credit_cents ?? 0))),
      memo: l.memo ? String(l.memo) : null,
    }));

    const totalDebitCents = lines.reduce((s, l) => s + l.debit_cents, 0);
    const totalCreditCents = lines.reduce((s, l) => s + l.credit_cents, 0);

    const predRaw = (parsed.prediction as Record<string, unknown>) ?? {};
    const predType = String(predRaw.type ?? 'NONE').toUpperCase();
    const prediction: { type: PredictionType; rationale: string | null } = {
      type: (['NONE', 'CAPEX', 'PREPAID', 'DEFERRED_REVENUE'].includes(predType) ? predType : 'NONE') as PredictionType,
      rationale: predRaw.rationale ? String(predRaw.rationale) : null,
    };

    const proposal: ComposerProposal = {
      memo: String(parsed.memo ?? ''),
      lines,
      balanced: totalDebitCents === totalCreditCents && totalDebitCents > 0,
      totalDebitCents,
      totalCreditCents,
      prediction,
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0))),
      clarifyingQuestion: parsed.clarifyingQuestion ? String(parsed.clarifyingQuestion) : null,
      notes: parsed.notes ? String(parsed.notes) : null,
    };

    return {
      success: true,
      proposal,
      tokensInput: result.usage?.input_tokens,
      tokensOutput: result.usage?.output_tokens,
      latencyMs: Date.now() - start,
    };
  } catch (e) {
    console.error('[je-composer] unexpected error:', e);
    return { success: false, error: e instanceof Error ? e.message : 'Compose failed' };
  }
}
