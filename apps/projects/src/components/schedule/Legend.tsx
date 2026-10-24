/** The Gantt legend (screen and print). Every mark has a word; none is colour alone. */
export function Legend({ critical, baseline, ghosts = false }: { critical: boolean; baseline: boolean; ghosts?: boolean }) {
  return (
    <div className="gx-legend" aria-label="Legend">
      <span><i />Task</span>
      {critical && <span><i className="crit" />Critical (no float)</span>}
      <span><i className="done" />Done</span>
      <span><i className="sum" />Phase</span>
      <span><i className="ms" />Milestone</span>
      {baseline && <span><i className="base" />Baseline</span>}
      {ghosts && <span><i className="ghost" />Where it moves to</span>}
      <span><i className="today" />Today</span>
      <span><i className="off" />Non-working day</span>
    </div>
  );
}
