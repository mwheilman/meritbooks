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
];

export {
  general, commercialGc, specialtyTrade, residentialRemodel, homeBuilder, fieldService, manufacturingEto,
  flooring, interiorDesign, equipmentDealer, realEstateDevelopment, professionalServices,
};
