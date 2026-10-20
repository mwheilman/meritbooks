export const dynamic = 'force-dynamic';

import { NoteDetailView } from './note-detail';

/** One floor-plan note: terms, balance, money events, curtailment schedule, payoff. */
export default function FloorPlanNotePage({ params }: { params: { id: string } }) {
  return <NoteDetailView id={params.id} />;
}
