import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import * as coreAi from '@meritbooks/core-ai';

// G0' rail proof: the Core AI gateway engine resolves via IN-PROCESS import
// (no HTTP bridge) from the standalone Projects app. G1 wires the full
// runAiGateway(deps, req) metered call writing core.ai_usage_log as module=PROJECTS.
export const GET = apiQueryHandler(null, async () => {
  return NextResponse.json({
    gatewayImportable: typeof coreAi.runAiGateway === 'function',
    tokensToCents: typeof coreAi.tokensToCents === 'function',
    exports: Object.keys(coreAi),
    note: 'in-process gateway import proven; full metered call lands in G1',
  });
});
