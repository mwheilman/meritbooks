'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, PageHead, Select, Tabs, useQuery } from '@meritbooks/merit-ui';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { useShellLine } from '@/components/layout/shell-context';
import { CASH_TABS, usd, type CashTab, type ScenariosResponse, type ForecastResponse } from './cash-types';
import { PositionTab } from './position-tab';
import { ForecastTab } from './forecast-tab';
import { ScenariosTab } from './scenarios-tab';
import { AccuracyTab } from './accuracy-tab';
import { SettingsTab } from './settings-tab';

/**
 * The cash workspace shell: tabs (Position · 13-week forecast · Scenarios · Accuracy · Settings),
 * the scenario switcher (?scenario=), and the shell context line. The company comes from the header
 * switcher (useActiveCompany); "All companies" is the consolidated read-only view.
 */
export function CashWorkspace() {
  const router = useRouter();
  const params = useSearchParams();
  const initialTab = (params.get('tab') as CashTab | null) ?? 'position';
  const [tab, setTabState] = useState<CashTab>(CASH_TABS.includes(initialTab) ? initialTab : 'position');
  const [scenarioId, setScenarioState] = useState<string>(params.get('scenario') ?? 'base');
  const [refreshKey, setRefreshKey] = useState(0);
  const { activeCompanyId, activeCompany, isAll, companies, setActiveCompany, ready } = useActiveCompany();
  const locationId = !isAll && activeCompanyId ? activeCompanyId : null;

  // A deep link (?company=) from a minimum-cash notification selects that company once.
  const linkCompany = params.get('company');
  useEffect(() => {
    if (ready && linkCompany && linkCompany !== activeCompanyId && companies.some((c) => c.id === linkCompany)) setActiveCompany(linkCompany);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, linkCompany]);

  const push = useCallback(
    (patch: Record<string, string | null>) => {
      const sp = new URLSearchParams(Array.from(params.entries()));
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) sp.delete(k);
        else sp.set(k, v);
      }
      sp.delete('company');
      router.replace(`/cash?${sp.toString()}`, { scroll: false });
    },
    [params, router],
  );
  const setTab = useCallback((t: CashTab) => {
    setTabState(t);
    push({ tab: t });
  }, [push]);
  const setScenario = useCallback((id: string) => {
    setScenarioState(id);
    push({ scenario: id === 'base' ? null : id });
  }, [push]);
  const changed = useCallback(() => setRefreshKey((k) => k + 1), []);

  const { data: scen } = useQuery<ScenariosResponse>('/api/cash/scenarios', { location_id: locationId ?? 'all' }, { key: `scen:${refreshKey}`, scope: false, enabled: ready });
  const scenarios = (scen?.scenarios ?? []).filter((s) => !s.isArchived);
  useEffect(() => {
    if (scenarioId !== 'base' && scen && !scenarios.some((s) => s.id === scenarioId)) setScenario('base');
  }, [scen, scenarioId, scenarios, setScenario]);

  // The headline for the shell line: the base forecast (shared cache key with the forecast tab).
  const fcq = useQuery<ForecastResponse>('/api/cash/forecast', { location_id: locationId ?? 'all', scenario_id: scenarioId }, { key: `fc:${refreshKey}`, scope: false, enabled: ready });
  const fc = fcq.data;
  const s = fc?.forecast.combined;
  useShellLine(
    s
      ? [
          { label: `${usd(s.openingCents)} cash today`, strong: true },
          `${usd(s.closingCents)} in 13 weeks`,
          s.firstBreach ? { label: `Below minimum in week ${s.firstBreach.weekIndex + 1}`, strong: true } : `Low point ${usd(s.lowPoint.cents)}`,
          fc?.scenario.id ? `Scenario: ${fc.scenario.name}` : 'Base forecast',
        ]
      : null,
    s ? `${s.openingCents}:${s.closingCents}:${s.firstBreach?.weekIndex ?? -1}:${fc?.scenario.id ?? 'base'}` : 'none',
  );

  const scopeLabel = activeCompany?.name ?? 'All companies';
  const breachCount = (fc?.forecast.companies ?? []).filter((c) => c.firstBreach).length;

  return (
    <div>
      <PageHead
        eyebrow={['Cash & treasury', scopeLabel]}
        title="Cash"
        actions={
          <>
            {(tab === 'forecast' || tab === 'position') && (
              <label className="row" style={{ gap: 8 }}>
                <span className="t-cap">Scenario</span>
                <Select aria-label="Scenario" value={scenarioId} onChange={(e) => setScenario(e.target.value)} style={{ minWidth: 200 }}>
                  <option value="base">Base forecast</option>
                  {scenarios.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                      {x.companyId ? '' : ' (all companies)'}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <Button variant="quiet" icon="plus" onClick={() => setTab('scenarios')}>
              New scenario
            </Button>
          </>
        }
      >
        <p className="t-cap">
          Cash today from the books and the bank, the next 13 weeks from every bill, invoice, payroll, loan, lease, subscription and tax on file, and how close past forecasts came.
          {isAll ? ' All companies combined — transfers between your companies are left out.' : ''}
        </p>
      </PageHead>

      <Tabs<CashTab>
        aria-label="Cash"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'position', label: 'Position' },
          { value: 'forecast', label: '13-week forecast', count: breachCount || undefined },
          { value: 'scenarios', label: 'Scenarios & items', count: scenarios.length || undefined },
          { value: 'accuracy', label: 'Accuracy' },
          { value: 'settings', label: 'Settings' },
        ]}
      />

      {!ready ? (
        <p className="t-cap" role="status" style={{ marginTop: 16 }}>
          Loading your companies…
        </p>
      ) : (
        <>
          {tab === 'position' && <PositionTab locationId={locationId} refreshKey={refreshKey} onOpenForecast={() => setTab('forecast')} forecast={fc} />}
          {tab === 'forecast' && <ForecastTab locationId={locationId} scenarioId={scenarioId} refreshKey={refreshKey} forecast={fcq} />}
          {tab === 'scenarios' && (
            <ScenariosTab
              locationId={locationId}
              companies={scen?.companies ?? companies.map((c) => ({ id: c.id, name: c.name }))}
              scenarios={scen?.scenarios ?? null}
              selectedId={scenarioId}
              onSelect={(id) => setScenario(id)}
              refreshKey={refreshKey}
              onChanged={changed}
              forecast={fc}
            />
          )}
          {tab === 'accuracy' && <AccuracyTab locationId={locationId} refreshKey={refreshKey} onChanged={changed} />}
          {tab === 'settings' && <SettingsTab locationId={locationId} refreshKey={refreshKey} onChanged={changed} />}
        </>
      )}
    </div>
  );
}
