/**
 * The company's industry experience (pack manifest v2): which manifest a company's install reads
 * its experience from, plus the tenant's /experience/… deltas from pm.pack_overrides. Pure and
 * client-safe (the server loader is experience-server.ts).
 *
 * Which manifest: the installed version when that version declares its own experience slots;
 * otherwise (a company installed on a v1 manifest) the latest published version of the same pack.
 * Experience is presentation only — rails, homes, tab order, field buttons — so following the
 * pack's latest wording never changes a job's data, stages or money; the job's install version
 * stays pinned for everything else.
 */
import { getPack, getPackInput } from '@meritbooks/industry-packs/src/catalog';
import {
  applyExperienceOverrides, compileExperience, homeFor, jobTabsFor, mobileActionsFor, multiJobViewFor, navFor, roleTitleFor,
  roleTitlesFor, scheduleViewFor, type PackOverride,
} from '@meritbooks/industry-packs/src/experience';
import type { PackManifest, PlanExperience } from '@meritbooks/industry-packs/src/types';

export {
  homeFor, jobTabsFor, mobileActionsFor, multiJobViewFor, navFor, roleTitleFor, roleTitlesFor, scheduleViewFor,
  type PackOverride, type PlanExperience,
};

export interface ExperienceInstall {
  pack_key: string;
  pack_version: string;
}

/** The manifest an install reads its experience from (null for an unknown pack). */
export function experienceManifest(install: ExperienceInstall): PackManifest | null {
  try {
    const own = getPackInput(install.pack_key, install.pack_version);
    if (own && own.nav !== undefined) return getPack(install.pack_key, install.pack_version) ?? null;
    return getPack(install.pack_key) ?? null;
  } catch {
    return null;
  }
}

export interface ExperienceInputs {
  primary: ExperienceInstall;
  /** Add-on packs merged into this company (their job types bring their own tabs). */
  addons?: ReadonlyArray<ExperienceInstall>;
  /** Active job type keys of the company (null = every job type of each pack). */
  jobTypeKeys?: ReadonlyArray<string> | null;
  overrides?: ReadonlyArray<PackOverride> | null;
}

export interface CompanyExperience {
  experience: PlanExperience;
  packKey: string;
  /** Version the experience was read from (may be newer than the install; see the header). */
  experienceVersion: string;
  skippedOverrides: number;
}

/** Compile one company's experience. Never throws: an unknown pack yields null (built-in rails). */
export function experienceFor(i: ExperienceInputs): CompanyExperience | null {
  const primary = experienceManifest(i.primary);
  if (!primary) return null;
  const keys = i.jobTypeKeys ? new Set(i.jobTypeKeys) : null;
  const part = (m: PackManifest) => ({
    manifest: m,
    jobTypeKeys: keys ? m.jobTypes.map((j) => j.key).filter((k) => keys.has(k)) : undefined,
  });
  const addons = (i.addons ?? [])
    .filter((a) => a.pack_key !== i.primary.pack_key)
    .map(experienceManifest)
    .filter((m): m is PackManifest => m !== null);
  try {
    const base = compileExperience(part(primary), addons.map(part));
    const r = applyExperienceOverrides(base, i.overrides ?? []);
    return { experience: r.experience, packKey: primary.key, experienceVersion: primary.version, skippedOverrides: r.skipped.length };
  } catch {
    return null;
  }
}
