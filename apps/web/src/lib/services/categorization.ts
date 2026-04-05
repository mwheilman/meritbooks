// AI categorization service — uses Anthropic when available, falls back to rule-based
import { createAdminSupabase } from '@/lib/supabase/server';

interface CategorizationResult {
  accountId: string | null;
  vendorId: string | null;
  departmentId: string | null;
  confidence: number;
  reasoning: string;
}

// Vendor pattern matching (rule-based, no AI needed)
export async function matchVendorPattern(
  description: string,
  orgId: string
): Promise<CategorizationResult | null> {
  const supabase = createAdminSupabase();
  
  const { data: patterns } = await supabase
    .from('vendor_patterns')
    .select('*, vendor:vendors(*)')
    .eq('org_id', orgId)
    .order('match_count', { ascending: false })
    .limit(100);
  
  if (!patterns?.length) return null;

  const normalized = description.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  
  let bestMatch: (typeof patterns)[0] | null = null;
  let bestScore = 0;

  for (const pattern of patterns) {
    const patternNorm = pattern.normalized_description.toLowerCase();
    // Simple substring match with scoring
    if (normalized.includes(patternNorm) || patternNorm.includes(normalized)) {
      const score = Math.min(patternNorm.length, normalized.length) / Math.max(patternNorm.length, normalized.length);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = pattern;
      }
    }
  }

  if (bestMatch && bestScore > 0.6) {
    return {
      accountId: bestMatch.account_id,
      vendorId: bestMatch.vendor_id,
      departmentId: bestMatch.department_id,
      confidence: Math.min(bestScore * 1.1, 0.99),
      reasoning: `Matched vendor pattern: ${bestMatch.raw_description}`,
    };
  }

  return null;
}

// AI categorization (optional - only runs if ANTHROPIC_API_KEY is set)
export async function aiCategorize(
  description: string,
  amountCents: number,
  orgId: string
): Promise<CategorizationResult> {
  // First try vendor pattern match
  const patternResult = await matchVendorPattern(description, orgId);
  if (patternResult && patternResult.confidence > 0.85) {
    return patternResult;
  }

  // If no API key, return low-confidence result
  if (!process.env.ANTHROPIC_API_KEY) {
    return patternResult || {
      accountId: null,
      vendorId: null,
      departmentId: null,
      confidence: 0,
      reasoning: 'No AI API key configured and no vendor pattern match found.',
    };
  }

  // Dynamic import to avoid build failures when package isn't installed
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Anthropic = (await import('@anthropic-ai/sdk' as string)).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Categorize this bank transaction for an HVAC/construction company:\nDescription: ${description}\nAmount: $${(amountCents / 100).toFixed(2)}\n\nRespond with JSON: {"account_suggestion": "string", "vendor_guess": "string", "confidence": 0.0-1.0, "reasoning": "string"}`,
      }],
    });

    const text = message.content[0].type === 'text' ? message.content[0].text : '';
    const parsed = JSON.parse(text);
    
    return {
      accountId: null,
      vendorId: null,
      departmentId: null,
      confidence: parsed.confidence || 0.5,
      reasoning: parsed.reasoning || 'AI categorization',
    };
  } catch {
    return patternResult || {
      accountId: null,
      vendorId: null,
      departmentId: null,
      confidence: 0,
      reasoning: 'AI categorization unavailable.',
    };
  }
}
