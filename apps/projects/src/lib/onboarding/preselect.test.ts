import { describe, expect, it } from 'vitest';
import { booksGuess, preselectCompanies, preselectCompany } from './preselect';

describe('company preselection', () => {
  it('existing jobs, job-style rev-rec or a contracting industry preselect', () => {
    expect(preselectCompany({ name: 'A', industry: null, revRecMethod: 'POINT_OF_SALE', jobCount: 3 })).toMatchObject({ selected: true });
    expect(preselectCompany({ name: 'B', industry: null, revRecMethod: 'PCT_COSTS_INCURRED', jobCount: 0 }).reasons[0]).toMatch(/percent complete/);
    expect(preselectCompany({ name: 'C', industry: 'Residential remodeling', revRecMethod: 'POINT_OF_SALE', jobCount: 0 }).selected).toBe(true);
    expect(preselectCompany({ name: 'D', industry: 'Software', revRecMethod: 'SUBSCRIPTION', jobCount: 0 }).selected).toBe(false);
  });

  it('the management company is never eligible', () => {
    expect(preselectCompany({ name: 'Merit Management Group', industry: 'Construction', revRecMethod: 'PCT_COMPLETE', jobCount: 9, isManagementCompany: true }))
      .toEqual({ eligible: false, selected: false, reasons: ['Management company'] });
  });

  it('when nothing qualifies, every eligible company starts checked', () => {
    const m = preselectCompanies([
      { id: '1', name: 'A', industry: 'Software', revRecMethod: 'SUBSCRIPTION', jobCount: 0 },
      { id: '2', name: 'B', industry: null, revRecMethod: null, jobCount: 0 },
    ]);
    expect([...m.values()].every((r) => r.selected)).toBe(true);
  });

  it('mixed list keeps the unqualified company unchecked', () => {
    const m = preselectCompanies([
      { id: '1', name: 'Heartland Heating & Cooling', industry: 'HVAC', revRecMethod: 'POINT_OF_SALE', jobCount: 0 },
      { id: '2', name: 'Holdings', industry: 'Investments', revRecMethod: 'POINT_OF_SALE', jobCount: 0 },
    ]);
    expect(m.get('1')!.selected).toBe(true);
    expect(m.get('2')!.selected).toBe(false);
  });

  it('Books guess is a suggestion from industry + rev-rec, null when Books says nothing', () => {
    expect(booksGuess({ name: 'Heartland Heating & Cooling', industry: 'HVAC', revRecMethod: 'POINT_OF_SALE', jobCount: 2 })?.packKey).toBe('field_service');
    expect(booksGuess({ name: 'Main Office', industry: null, revRecMethod: 'POINT_OF_SALE', jobCount: 0 })).toBeNull();
  });
});
