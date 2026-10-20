/**
 * SSR smoke tests: the shell and components render in Node (no window access
 * during render), with the kit's class names and ARIA.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  AppShell,
  Bands,
  Bar,
  Button,
  CmdkTrigger,
  Conf,
  ContextChip,
  ContextLine,
  Crumbs,
  Dash,
  Field,
  Figure,
  InlineNotice,
  Keybar,
  MeritProvider,
  MoneyInput,
  Page,
  PageHead,
  QueueTable,
  Rail,
  RailFoot,
  RailGroup,
  RailLink,
  RailNav,
  Seg,
  StageMeter,
  Status,
  SupportBand,
  SyncStatus,
  Tabs,
  Widget,
  WidgetState,
  AiPaused,
  NotePanel,
  Panel,
  PanelSection,
  createHotkeyRegistry,
  filterNav,
  scoreStrokes,
  stepStrokes,
  productsGroup,
} from '../src';

const render = (node: React.ReactElement) => renderToStaticMarkup(<MeritProvider hotkeys={createHotkeyRegistry()}>{node}</MeritProvider>);

describe('shell', () => {
  it('renders the S1 grammar: .app[data-context] → rail lockup, bar chip/crumbs/cmdk/sync, ctxline, page', () => {
    const html = render(
      <AppShell
        context="client"
        density="cockpit"
        rail={
          <Rail module="projects" foot={<RailFoot eyebrow="Week 43" period={{ value: 'Oct 19', of: '– Oct 25' }} user={{ initials: 'DL', name: 'Dana Lee', role: 'Project manager · 6 jobs' }} />}>
            <RailGroup label="Home">
              <RailLink href="/" active keys="g h">
                Home
              </RailLink>
              <RailLink href="/inbox" count={4}>
                Inbox
              </RailLink>
              <RailLink href="/review" count="Blocked" alert>
                To review
              </RailLink>
            </RailGroup>
          </Rail>
        }
        bar={
          <Bar>
            <ContextChip name="Heartland Heating & Cooling" meta="C-103 · Sep open" pip="open" onOpen={() => {}} />
            <Crumbs items={[{ label: 'Jobs', href: '/jobs' }, { label: 'J-1042 Ankeny clinic', href: '/jobs/J-1042' }, { label: 'Budget' }]} />
            <CmdkTrigger onOpen={() => {}} />
            <SyncStatus>Synced 9:38 AM</SyncStatus>
          </Bar>
        }
      >
        <ContextLine items={['Mon Oct 19', 'Week 43', { label: '3 jobs over budget', strong: true }, '2 draws due Fri']} />
        <Page>
          <PageHead eyebrow={['Jobs', 'Heartland']} title="Budget" actions={<Button variant="primary" chord="shift+a">Approve 3</Button>} />
        </Page>
      </AppShell>,
    );
    expect(html).toContain('class="app density-cockpit app--viewport" data-context="client"');
    expect(html).toContain('<a class="skip" href="#main">Skip to content</a>');
    expect(html).toContain('<div class="rail-logo">');
    expect(html).toContain('src="/brand/lockups/merit-projects-horizontal-on-dark.svg" alt="Merit Projects" width="161" height="24"');
    expect(html).toContain('<div class="rail-group"');
    expect(html).toContain('<a class="rail-link" href="/" aria-current="page">Home');
    expect(html).toContain('<span class="keys" aria-hidden="true"><kbd class="kbd">G</kbd><kbd class="kbd">H</kbd></span>');
    expect(html).toContain('<span class="count">4</span>');
    expect(html).toContain('<span class="count count--alert">Blocked</span>');
    expect(html).toContain('class="ctx"');
    expect(html).toContain('aria-haspopup="dialog" aria-expanded="false"');
    expect(html).toContain('<kbd class="kbd">⌘J</kbd>');
    expect(html).toContain('<kbd class="kbd">⌘K</kbd>');
    expect(html).toContain('<b aria-current="page">Budget</b>');
    expect(html).toContain('class="ctxline"');
    expect(html).toContain('<span class="sl" aria-hidden="true">//</span>');
    expect(html).toContain('<b>3 jobs over budget</b>');
    expect(html).toContain('<h1 class="t-title" style="margin-top:4px">Budget</h1>');
    expect(html).toContain('class="btn btn--primary"');
    expect(html).toContain('<kbd class="kbd">⇧</kbd><kbd class="kbd">A</kbd>');
    expect(html).not.toMatch(/MeritProjects|>Projects</); // never the product word as live text
  });

  it('own and consolidated chips carry their tags; support band sits above the shell', () => {
    const html = render(
      <AppShell
        context="consolidated"
        density="report"
        band={<SupportBand lead="Support session" facts={['Alex Kim, Merit Platform', 'Read-only']} remaining="42:00" remainingLabel="42 minutes left" onEnd={() => {}} />}
        rail={<Rail module="projects"><RailLink href="/">Home</RailLink></Rail>}
        bar={
          <Bar>
            <ContextChip name="Merit Management Group — Consolidated" icon="layers" tag={{ kind: 'ro' }} onOpen={() => {}} />
          </Bar>
        }
      >
        <Page>…</Page>
      </AppShell>,
    );
    expect(html).toContain('data-context="consolidated"');
    expect(html).toContain('density-report');
    expect(html).toContain('<div class="support-band" role="status" aria-live="off">');
    expect(html).toContain('<span class="ctx-tag ctx-tag--ro">Read-only</span>');
  });

  it('RailNav renders a filtered tree with a More fold', () => {
    const groups = filterNav(
      [{ id: 'c', label: 'Controls', items: [{ label: 'Audit trail', href: '/audit' }, { label: 'AI decisions', href: '/ai', disclosure: 'M' }] }],
      { context: 'client' },
    );
    const html = render(
      <Rail module="projects">
        <RailNav groups={groups} pathname="/audit" />
      </Rail>,
    );
    expect(html).toContain('<a class="rail-link" href="/audit" aria-current="page">Audit trail</a>');
    expect(html).toContain('More<span class="count">1</span>');
  });

  it('productsGroup names products with the two-word names', () => {
    const g = productsGroup('projects', [
      { module: 'books', href: 'https://books.example/' },
      { module: 'projects', href: '/' },
    ]);
    expect(g.label).toBe('Products');
    expect(g.items.map((i) => i.label)).toEqual(['Merit Books', 'Merit Projects']);
    expect(g.items[1]?.current).toBe(true);
  });
});

describe('primitives', () => {
  it('status is shape + word', () => {
    expect(renderToStaticMarkup(<Status kind="risk" />)).toBe('<span class="status status--risk"><i class="pip pip--risk" aria-hidden="true"></i>At risk</span>');
    expect(renderToStaticMarkup(<Status kind="track" pip="open">Sep open</Status>)).toContain('pip--open');
  });

  it('meters read by count and are labelled', () => {
    expect(scoreStrokes(97)).toEqual(['on', 'on', 'on', 'on', 'on']);
    expect(scoreStrokes(74)).toEqual(['on', 'on', 'on', 'part', 'off']);
    expect(scoreStrokes(58)).toEqual(['on', 'on', 'part', 'off', 'off']);
    expect(scoreStrokes(63)).toEqual(['on', 'on', 'on', 'off', 'off']);
    expect(stepStrokes(8, 1, { blocked: true })).toEqual(['on', 'bad', 'off', 'off', 'off', 'off', 'off', 'off']);
    const conf = renderToStaticMarkup(<Conf score={41} />);
    expect(conf).toContain('class="conf conf--lo"');
    expect(conf).toContain('role="img" aria-label="Confidence 41 of 100"');
    const stage = renderToStaticMarkup(<StageMeter stages={['Plan', 'Connect', 'Preflight', 'Map', 'Tie out', 'Shadow', 'Certified', 'Live']} current={3} detail="day 3" />);
    expect(stage).toContain('class="stgw"');
    expect(stage).toContain('aria-label="Stage 4 of 8, Map"');
    expect(stage.match(/<i/g)?.length).toBe(8);
  });

  it('tabs, seg and bands use the kit ARIA states', () => {
    const tabs = renderToStaticMarkup(<Tabs aria-label="Views" value="review" onChange={() => {}} items={[{ value: 'review', label: 'To review', count: 41 }, { value: 'posted', label: 'Posted' }]} />);
    expect(tabs).toContain('role="tablist"');
    expect(tabs).toContain('class="tab" aria-selected="true" tabindex="0">To review<span class="n">41</span>');
    const seg = renderToStaticMarkup(<Seg aria-label="Columns" value="a" onChange={() => {}} items={[{ value: 'a', label: 'Consolidated' }, { value: 'b', label: 'By company' }]} />);
    expect(seg).toContain('aria-pressed="true"');
    const bands = renderToStaticMarkup(<Bands aria-label="Bands" value="decide" onChange={() => {}} items={[{ value: 'decide', label: 'Decide', count: 6, caption: 'Under 70' }, { value: 'check', label: 'Check', count: 12 }, { value: 'ready', label: 'Ready', count: 23 }]} />);
    expect(bands).toContain('class="band-tab" aria-selected="true"');
    expect(bands).toContain('<span class="v">6</span>');
  });

  it('fields wire label, help/error and money input', () => {
    const html = render(
      <Field label="Contract value" error="Off by 1,240.00 from the SOV. Check the change orders.">
        <MoneyInput valueCents={318462} onChangeCents={() => {}} />
      </Field>,
    );
    expect(html).toContain('class="field-label"');
    expect(html).toContain('class="input input--money is-error"');
    expect(html).toContain('value="3,184.62"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('class="field-error"');
    expect(html).toMatch(/aria-describedby="[^"]+-err"/);
  });

  it('a figure always has a comparison and a destination', () => {
    const html = render(<Figure label="Committed cost · Sep" value="8,411,220" vs={['+612,034 vs Aug', 'vs budget 7,900,000']} href="/cost" linkLabel="Job cost" />);
    expect(html).toContain('class="fig"');
    expect(html).toContain('class="fig-v tnum"');
    expect(html).toContain('<a class="link" href="/cost">Job cost</a>');
  });

  it('keybar prints every key next to its verb', () => {
    const html = renderToStaticMarkup(<Keybar hints={[{ chord: 'j k', label: 'move' }, { chord: 'x', label: 'select' }, { chord: 'a', label: 'approve' }]} note="Nothing posts until you approve it" />);
    expect(html).toContain('class="keybar"');
    expect(html).toContain('<kbd class="kbd">J</kbd><kbd class="kbd">K</kbd> move');
  });
});

describe('queue, dash, AI states', () => {
  type Co = { id: string; title: string; amount: string };
  const rows: Co[] = [
    { id: 'co-14', title: 'CO-014 Owner-added outlets', amount: '(4,812.00)' },
    { id: 'co-15', title: 'CO-015 Duct reroute', amount: '642.18' },
  ];

  it('queue table renders groups, the select column and grid semantics', () => {
    const html = render(
      <QueueTable<Co>
        aria-label="Heartland, change orders to review"
        selectable
        groups={[{ id: 'decide', title: 'Decide', caption: 'Under 70, or the AI has a question', rows }]}
        getRowId={(r) => r.id}
        rowState={(r) => ({ attn: r.id === 'co-14' })}
        columns={[
          { id: 'co', header: 'Change order', cell: (r) => <span className="l1">{r.title}</span> },
          { id: 'amt', header: 'Amount', numeric: true, width: 120, cell: (r) => r.amount },
        ]}
      />,
    );
    expect(html).toContain('class="tbl tbl-q"');
    expect(html).toContain('role="grid"');
    expect(html).toContain('aria-multiselectable="true"');
    expect(html).toMatch(/<tr class="q-group"><td colspan="3"/i);
    expect(html).toContain('<span class="q-group-t">Decide</span>');
    expect(html).toContain('class="q-row is-attn"');
    expect(html).toContain('<td class="n">(4,812.00)</td>');
    expect(html).not.toContain('class="bulk"'); // only on selection
  });

  it('widget states: loading/empty/done/error and the primary rule', () => {
    const html = render(
      <Dash>
        <Widget primary w={8} h={4} title="My jobs" count={6} meta="Ranked by margin fade" state={{ kind: 'loading', label: 'Loading 6 jobs…' }} />
        <Widget w={4} h={4} title="Due this week" state={{ kind: 'done', title: 'Nothing due until Oct 26', body: 'The Ankeny clinic draw is next.' }} />
        <Widget w={3} title="Subcontractors" state={{ kind: 'empty', title: 'No subcontractors added yet', body: 'Import them from Buildertrend or add the first one.' }} />
        <Widget w={3} title="Draws" state={{ kind: 'error', title: 'Couldn’t reach the lender portal', body: 'Draws are safe. Try again, or check the connection in Integrations.', onRetry: () => {} }} />
      </Dash>,
    );
    expect(html).toContain('class="wg wg--primary wg-loading" style="--w:8;--h:4"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="bar-l"');
    expect(html).toContain('class="wg-done-mark"');
    expect(html).toContain('class="wg-empty-mark"');
    expect(html).toContain('class="tag tag--neg">Not loaded</span>');
  });

  it('refuses the banned empty copy in development', () => {
    expect(() => renderToStaticMarkup(<WidgetState state={{ kind: 'empty', title: 'No ' + 'data' }} />)).toThrow(/banned/);
  });

  it('AI paused is calm and inline; the panel note is provisional', () => {
    const inline = renderToStaticMarkup(<AiPaused>Rules still route change orders. 13 wait for you.</AiPaused>);
    expect(inline).toContain('class="inline-notice"');
    expect(inline).toContain('<b>AI assist paused.</b>');
    const widget = renderToStaticMarkup(<AiPaused variant="widget" title="Rules still routing change orders" />);
    expect(widget).toContain('class="wg-state"');
    expect(widget).toContain('<span class="tag">AI paused</span>');
    const panel = render(
      <Panel aria-label="Change order detail" eyebrow={['Check band', '3 of 12']} title="CO-015 Duct reroute" figure="642.18" onClose={() => {}} foot={<Button variant="primary">Approve</Button>}>
        <PanelSection>
          <NotePanel confidence={74} title="Cost code 23-31 Ductwork" why={[{ text: '9 of 11 prior Ferguson bills went to 23-31' }, { text: 'Job is a guess', against: true }]} basis={['Vendor memory + PO 4471', 'Nothing posts until you approve']} />
        </PanelSection>
      </Panel>,
    );
    expect(panel).toContain('class="note note--panel"');
    expect(panel).toContain('<span class="tag tag--ai">AI suggestion</span>');
    expect(panel).toContain('<li class="against"><span class="sr">Against: </span>Job is a guess</li>');
    expect(panel).toContain('class="panel-foot"');
    expect(panel).toContain('aria-label="Close panel"');
  });

  it('inline notice tones and roles', () => {
    expect(renderToStaticMarkup(<InlineNotice tone="neg" title="Bank of Iowa ••4471 disconnected 3 days.">Draws can’t post until it reconnects.</InlineNotice>)).toContain('class="inline-notice inline-notice--neg" role="alert"');
  });

  it('dev warns for an icon-only button without a label', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Button iconOnly icon="flag" />);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
