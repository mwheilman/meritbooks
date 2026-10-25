/** The source adapters (PLT-68), in tile order. */
import type { AdapterEntity, ImportEntity, SourceAdapter, SourceSystem } from '../types';
import { buildertrend, coconstruct, jobtread } from './residential';
import { fieldedge, housecallPro, jobber, servicetitan, simpro } from './field-service';
import { csystems } from './dealer';
import { excel, procore } from './commercial';
import { quickbooks } from './accounting';

export { buildertrend, jobtread, coconstruct, servicetitan, fieldedge, simpro, housecallPro, jobber, csystems, procore, excel, quickbooks };

export const ADAPTERS: readonly SourceAdapter[] = [
  buildertrend, jobtread, coconstruct, servicetitan, fieldedge, simpro, housecallPro, jobber, csystems, procore, excel, quickbooks,
];

export function adapterFor(id: SourceSystem): SourceAdapter | null {
  return ADAPTERS.find((a) => a.id === id) ?? null;
}

export function recipeFor(id: SourceSystem, entity: ImportEntity): AdapterEntity | null {
  return adapterFor(id)?.entities.find((e) => e.entity === entity) ?? null;
}
