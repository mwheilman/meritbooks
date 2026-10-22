import { Dash, Widget } from '@meritbooks/merit-ui';

/** The kit loading state for both homes: skeleton widgets shaped like the real grid. */
export function HomeSkeleton({ kind }: { kind: 'workspace' | 'client' }) {
  if (kind === 'client') {
    return (
      <div className="mb-home" aria-busy="true">
        <div className="mb-loop mb-loop--loading" aria-hidden="true">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="mb-lstep">
              <span className="num">{n}</span>
              <span className="wg-loading" style={{ display: 'grid', gap: 8 }}>
                <span className="bar-l" style={{ width: '60%' }} />
                <span className="bar-l" style={{ width: '80%' }} />
              </span>
            </div>
          ))}
        </div>
        <Dash flow="row" className="mb-home-dash">
          <Widget primary title="Bank & card feed" w={8} h={4} state={{ kind: 'loading', label: 'Reading the open feed…', lines: 5 }} />
          <Widget title="Money" w={4} h={2} state={{ kind: 'loading', label: 'Reading cash, receivables and payables…' }} />
          <Widget title="Latest activity" w={4} h={2} state={{ kind: 'loading', label: 'Reading recent transactions…' }} />
        </Dash>
      </div>
    );
  }
  return (
    <Dash flow="row" className="mb-home-dash">
      <Widget primary title="Your clients" w={8} h={4} state={{ kind: 'loading', label: 'Reading every client’s queues…', lines: 5 }} />
      <Widget title="Across your clients" w={4} h={2} state={{ kind: 'loading', label: 'Reading cash, receivables and payables…' }} />
      <Widget title="This month’s close" w={4} h={2} state={{ kind: 'loading', label: 'Reading period status…' }} />
      <Widget title="Needs your judgment" w={8} h={2} state={{ kind: 'loading', label: 'Counting queues…' }} />
      <Widget title="Latest activity" w={4} h={2} state={{ kind: 'loading', label: 'Reading recent transactions…' }} />
    </Dash>
  );
}
