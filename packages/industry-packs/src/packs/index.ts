import type { PackManifestInput } from '../types';
import { general } from './general';
import { commercialGc } from './commercial_gc';
import { specialtyTrade } from './specialty_trade';
import { residentialRemodel } from './residential_remodel';
import { homeBuilder } from './home_builder';
import { fieldService } from './field_service';
import { manufacturingEto } from './manufacturing_eto';
import { flooring } from './flooring';
import { interiorDesign } from './interior_design';
import { equipmentDealer } from './equipment_dealer';
import { realEstateDevelopment } from './real_estate_development';
import { professionalServices } from './professional_services';
import {
  commercialGcExperience, equipmentDealerExperience, fieldServiceExperience, flooringExperience, generalExperience,
  homeBuilderExperience, interiorDesignExperience, manufacturingEtoExperience, professionalServicesExperience,
  realEstateDevelopmentExperience, residentialRemodelExperience, specialtyTradeExperience, type ExperienceSlots,
} from './experience';

/** A new published version: the previous manifest plus the v2 experience slots. */
function withExperience(base: PackManifestInput, version: string, exp: ExperienceSlots): PackManifestInput {
  return { ...base, version, ...exp };
}

/** Manifest v2 (PLAN_SCHEMA_VERSION 2): experience slots. The v1 versions above stay published and loadable. */
export const PACK_MANIFESTS_V2: readonly PackManifestInput[] = [
  withExperience(commercialGc, '1.1.0', commercialGcExperience),
  withExperience(specialtyTrade, '1.1.0', specialtyTradeExperience),
  withExperience(residentialRemodel, '1.1.0', residentialRemodelExperience),
  withExperience(homeBuilder, '1.1.0', homeBuilderExperience),
  withExperience(fieldService, '1.1.0', fieldServiceExperience),
  withExperience(manufacturingEto, '1.1.0', manufacturingEtoExperience),
  withExperience(flooring, '1.1.0', flooringExperience),
  withExperience(interiorDesign, '1.1.0', interiorDesignExperience),
  withExperience(equipmentDealer, '1.2.0', equipmentDealerExperience),
  withExperience(realEstateDevelopment, '1.1.0', realEstateDevelopmentExperience),
  withExperience(professionalServices, '1.1.0', professionalServicesExperience),
  withExperience(general, '1.1.0', generalExperience),
];

/** Every published manifest version, in tile order. Add a new version by appending, never editing a published one. */
export const PACK_MANIFESTS: readonly PackManifestInput[] = [
  commercialGc,
  specialtyTrade,
  residentialRemodel,
  homeBuilder,
  fieldService,
  manufacturingEto,
  flooring,
  interiorDesign,
  equipmentDealer,
  realEstateDevelopment,
  professionalServices,
  general,
  ...PACK_MANIFESTS_V2,
];

export {
  general, commercialGc, specialtyTrade, residentialRemodel, homeBuilder, fieldService, manufacturingEto,
  flooring, interiorDesign, equipmentDealer, realEstateDevelopment, professionalServices,
};
