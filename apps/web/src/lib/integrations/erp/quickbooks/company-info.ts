/**
 * CompanyInfo → a prefill card for onboarding ("Fetch, don't ask" — FPB §2.2).
 * Pure; every field is optional because QBO companies are often half-filled.
 */

type Obj = Record<string, unknown>;

export interface QboAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface QboCompanyProfile {
  /** The name the owner sees in QuickBooks. */
  companyName: string | null;
  /** Legal name (falls back to companyName when QBO has none). */
  legalName: string | null;
  address: QboAddress | null;
  /** Federal EIN when QuickBooks has it on file. */
  ein: string | null;
  /** 1–12; null when unknown. */
  fiscalYearStartMonth: number | null;
  country: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function obj(v: unknown): Obj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

export function monthNameToNumber(v: unknown): number | null {
  const s = str(v)?.toLowerCase();
  if (!s) return null;
  const idx = MONTHS.findIndex((m) => m === s || m.slice(0, 3) === s.slice(0, 3));
  if (idx >= 0) return idx + 1;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

function addr(v: unknown): QboAddress | null {
  const a = obj(v);
  if (!a) return null;
  const out: QboAddress = {
    line1: str(a.Line1),
    line2: str(a.Line2),
    city: str(a.City),
    region: str(a.CountrySubDivisionCode),
    postalCode: str(a.PostalCode),
    country: str(a.Country),
  };
  return Object.values(out).some((x) => x !== null) ? out : null;
}

/** Normalize a US EIN to "12-3456789"; return null for anything that isn't 9 digits. */
export function normalizeEin(v: unknown): string | null {
  const digits = (str(v) ?? '').replace(/\D/g, '');
  return digits.length === 9 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : null;
}

function einFrom(ci: Obj): string | null {
  const direct = normalizeEin(ci.EmployerId);
  if (direct) return direct;
  const nv = Array.isArray(ci.NameValue) ? (ci.NameValue as Obj[]) : [];
  for (const item of nv) {
    if (/employerid|^ein$|taxid|federaltax/i.test(String(item.Name ?? ''))) {
      const v = normalizeEin(item.Value);
      if (v) return v;
    }
  }
  return null;
}

/** Accepts the raw `/companyinfo/{realmId}` response or the inner CompanyInfo object. */
export function parseCompanyInfo(json: unknown): QboCompanyProfile {
  const root = obj(json);
  const ci = obj(root?.CompanyInfo) ?? root ?? {};
  const companyName = str(ci.CompanyName);
  return {
    companyName,
    legalName: str(ci.LegalName) ?? companyName,
    address: addr(ci.LegalAddr) ?? addr(ci.CompanyAddr),
    ein: einFrom(ci),
    fiscalYearStartMonth: monthNameToNumber(ci.FiscalYearStartMonth),
    country: str(ci.Country),
    email: str(obj(ci.Email)?.Address),
    phone: str(obj(ci.PrimaryPhone)?.FreeFormNumber),
    website: str(obj(ci.WebAddr)?.URI),
  };
}
