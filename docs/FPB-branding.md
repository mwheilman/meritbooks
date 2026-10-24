# FPB — Brand from logo (tenant + company brand profiles)

Status: authored 2026-10-24 (builder slice "Brand from logo", migration **190**).
Owner's words: *"on invoices and the system in general, the customer should be able to upload
its own logo and the system should choose colors consistent with that."*

Related: FPB-invoices §4 (Slice 1B design templates, logo allowlist), FPB-request-engine-
notifications (request emails / magic-link pages), FPB-vendor-compliance-chase (vendor portal),
FPB-workforce-app (Merit Workforce), FPB-payments-fees (pay page).

---

## 1. Purpose

A tenant (and any of its companies) uploads its own logo once. MeritBooks reads the logo's
colours, proposes an accessible palette, and from then on every **customer-facing** surface —
invoice / statement / estimate PDFs, invoice + statement + dunning + request emails, the hosted
pay page, the customer portal, the vendor portal, the request magic-link pages and the Merit
Workforce header — wears that brand. Nobody types a hex code unless they want to.

## 2. Persona

- **Tenant admin / owner** (settings_system edit): sets the tenant brand once, decides which
  companies use it and which have their own.
- **Their customers, vendors, employees** (no login): see the issuing company's brand, never a
  generic Merit look and never another tenant's.
- **Bookkeeper / AR clerk**: never thinks about colours — invoice templates inherit the brand.

## 3. Benchmark (named deltas)

| Product | What they do | Our delta |
|---|---|---|
| QuickBooks Online | Logo + one "brand colour" picked by hand per template | We derive the palette from the logo and guarantee contrast |
| Xero | Branding themes per document type, manual colours | One brand profile drives every surface; templates inherit |
| Stripe Invoicing | Brand colour + accent colour + icon/logo, used on emails, pay page and PDF | Same split (primary/accent, logo + square mark), plus per-company override and AA auto-fix |
| Canva / Looka brand kits | Suggest palettes from a logo | We do it in-product, at upload, with a live preview of the real surfaces |

## 4. Decisions

1. **The Merit brand is the PLATFORM brand.** The in-app product chrome (rail, bar, buttons,
   tables) stays merit-ui v2.3. The tenant brand appears **only** in the brand area at the top of
   the rail: tenant logo (or mark when the rail is mini) + "Powered by Merit Books" (small). The
   optional tenant accent is used only as the brand-area rule. We do NOT recolour the product.
   *Full white-label later* = a merit-ui token override: set `--electric`, `--signal` (and
   optionally `--midnight`) on `.app-shell` from the resolved brand (`brandCssVars()`), behind an
   entitlement. No component changes needed because every kit component reads the tokens.
2. **Inheritance:** company brand → tenant brand → Merit default. A company row with
   `use_tenant_brand = true` (the default) resolves to the tenant brand; the company row is kept
   so switching back restores its own settings.
3. **Invoice templates inherit the brand** (`invoice_templates.inherit_brand`, default true). When
   true AND a brand profile exists, the template's logo, accent colour and font come from the
   resolved company brand. A template can switch inheritance off to keep its own logo/colour
   (the template editor shows "Use company brand"). Existing templates with a non-default accent
   or a logo are migrated with `inherit_brand = false` (their explicit choice is preserved).
4. **Files:** PNG / JPEG only, ≤ 2 MB, checked by magic bytes server-side (reuses Slice 1B's
   `sniffLogoType`). **SVG is refused**: the PDF renderer can't draw it and we will not ship a
   server-side SVG sanitizer in this slice (an unsanitized SVG on a public bucket is a stored-XSS
   vector). Files live in the public `branding` bucket under `${orgId}/brand-…`, the only path
   `isTenantLogoUrl` accepts — no other URL can ever reach a renderer (SSRF guard unchanged).
5. **Palette extraction runs in the browser** (canvas, no new dependency): the server never
   decodes images. The server **re-validates** every hex value and recomputes the contrast
   report — it never trusts the client's report.
6. **Accessibility is enforced, not advised:** `primary` must reach WCAG AA 4.5:1 against white
   (it is used for text links and button fills with white/ink text); `on_primary` is chosen by
   contrast; `ink` must reach 4.5:1 on `surface`. A manual palette that fails is refused on save
   with the failing pair named, and the editor offers "Fix contrast" (darkens in OKLCH until it
   passes, hue kept).
7. **Fonts** from a safe set only: `DM_SANS` (default), `SYSTEM` (system UI stack, Inter-like),
   `SERIF`. PDFs map SERIF → the built-in Times face, everything else → Helvetica (deterministic
   bytes, no network font fetch).

## 5. UI (what the owner sees) — `/settings/brand`, merit-ui v2.3, `density-cockpit`

- Header: "Brand" — *Your logo and colours on invoices, emails, the pay page and portals.*
- Left list: **Tenant brand** (first row) then every active company, each with a swatch strip
  and "Uses tenant brand" / "Own brand" / "Merit default".
- Editor (right):
  - `01 // LOGO` — three slots: *Logo (light backgrounds)*, *Logo for dark backgrounds*
    (optional), *Square mark* (optional; used where space is small — the mini rail, favicons
    later). Upload, replace, remove. Errors are plain English ("Use a PNG or JPG").
  - `02 // COLOURS` — after a logo upload: "Colours found in your logo" (the extracted swatches)
    and **2–3 suggested palettes** (cards: *Brand*, *Complementary* / *Analogous*, *Quiet*). Pick
    one. Below: six hex fields (primary, secondary, accent, ink, surface, on-primary) with a live
    contrast line each ("4.9:1 on white · AA ✓" / "2.8:1 — too light for text"), "Fix contrast".
  - `03 // TYPE` — DM Sans · System · Serif (Seg).
  - Company only: **Use tenant brand** switch (on = everything above is the tenant's, read-only
    with an "Edit tenant brand" link).
  - `04 // PREVIEW` — live: invoice header + totals band, email header + button, pay-page header
    + Pay button, portal band. Updates as you type.
  - Save (primary) · Reset to Merit default (confirm).
- States: loading skeleton, error notice with retry, empty (no companies → tenant only),
  403 (no access message).

## 6. Data model (migration 190)

`public.brand_profiles` — one row per tenant (`location_id is null`) and per company.

| column | type | notes |
|---|---|---|
| id, org_id, location_id | uuid | unique (org_id, coalesce(location_id, 0-uuid)) |
| use_tenant_brand | boolean default true | company rows only (tenant row forced true, meaningless) |
| logo_url, logo_dark_url, mark_url | text ≤ 1000 | app-validated `isTenantLogoUrl` |
| primary_color, secondary_color, accent_color, ink_color, surface_color, on_primary_color | text `^#[0-9A-Fa-f]{6}$` | |
| font | text DM_SANS · SYSTEM · SERIF | |
| palette_source | text derived · manual | |
| extracted_colors | jsonb array | swatches the browser found (display only) |
| contrast_report | jsonb object | recomputed server-side on save |
| updated_by, created_at, updated_at | | |

`public.invoice_templates.inherit_brand boolean not null default true` (existing rows with a
non-default accent or a logo → false on first add).

RLS: member SELECT (org), service_all; INSERT/UPDATE/DELETE revoked from anon/authenticated
(171/176 write-lock pattern). Client scope re-applied (location_id; null = tenant row visible to
all members of the org). No functions, no GL effect.

## 7. Resolution (`lib/branding/resolve.ts`)

`pickBrand(tenantRow, companyRow)` →
1. company row exists AND `use_tenant_brand = false` → **COMPANY**
2. tenant row exists → **TENANT**
3. → **MERIT_DEFAULT** (Electric Blue #2563EB, ink Midnight, surface Sky, DM Sans, no logo)

A logo slot left empty on a company brand falls back to the tenant's logo for that slot.
`applyBrandToTemplate(template, brand)` — when `template.inherit_brand` and brand source ≠
MERIT_DEFAULT: logo (brand logo ?? template logo), accent = brand primary, font (SERIF/SANS).

Every customer-facing renderer reads the brand through this one resolver:
`resolveInvoiceTemplate` / `loadBrandTemplate` (invoice PDF, invoice email, pay page, collections
reminder, statements, estimates, 1099 copies), `loadCustomerPortal`, request dispatch emails,
`/r/[token]`, the vendor portal, Merit Workforce (`loadHolderView`), and the shell brand area
(`GET /api/settings/brand/shell`).

## 8. Validation & gates

- Routes: `GET/PUT /api/settings/brand` and `POST /api/settings/brand/logo` require
  `settings_system:edit` (GET: `settings_system:view`), org from the verified session, company
  asserted in the caller's client scope (`assertWriteScope`), writes via `serviceWriter()`.
- `GET /api/settings/brand/shell` — any signed-in member of the org (it returns only the tenant
  logo URLs + two colours, which are public on every invoice anyway).
- Zod: hex `^#[0-9a-fA-F]{6}$`, font enum, logo URLs through `isTenantLogoUrl(orgId)`.
- Server re-computes contrast; refuses `primary` < 4.5:1 on white, `on_primary` < 4.5:1 on
  primary, `ink` < 4.5:1 on `surface`.

## 9. Acceptance criteria (testable)

- **AC-1 Extraction:** `extractPalette(pixels)` returns dominant colours ordered by share;
  transparent (α < 128), near-white (L > 0.95) and near-black (L < 0.06) pixels are ignored; a
  logo on a white background returns the logo's colour, not white. *(extract.test.ts)*
- **AC-2 Monochrome:** a single-hue or greyscale logo still yields a valid palette: secondary and
  accent are derived (analogous / complementary) and distinct from primary. *(palette.test.ts)*
- **AC-3 AA always:** for any input colour (incl. #FFFF00, #FFFFFF, #00FF00) `ensureContrast`
  returns a colour ≥ 4.5:1 against white with the hue preserved within 15°. Every suggested
  palette passes `contrastReport().ok`. *(color.test.ts, palette.test.ts — property sweep)*
- **AC-4 Suggestions:** `suggestPalettes()` returns 2–3 distinct palettes, each with all six
  colours and `on_primary` chosen by contrast. *(palette.test.ts)*
- **AC-5 Inheritance:** company(own) → company; company(use tenant) → tenant; no rows → Merit
  default; company empty logo slot → tenant logo. *(resolve.test.ts)*
- **AC-6 Templates inherit:** `applyBrandToTemplate` overrides logo/accent/font when
  `inherit_brand` and the brand is not the Merit default; never when `inherit_brand=false`; never
  for MERIT_DEFAULT (an existing template keeps its own colour). *(resolve.test.ts)*
- **AC-7 Renderers read the brand:** the invoice email built from a doc whose template was
  branded carries the brand primary and the logo; the request email carries the brand primary on
  its button and the logo in the head; the dunning letter carries the brand colour. *(email
  tests)*
- **AC-8 Upload validation:** PNG/JPEG magic bytes accepted; SVG / WebP / HTML refused; > 2 MB
  refused; a non-tenant URL refused on save. *(schema/service tests)*
- **AC-9 RLS / permissions:** `brand_profiles` exists with RLS on, member SELECT only (member
  INSERT fails), one tenant row per org, one row per company, hex CHECK rejects `red`;
  `invoice_templates.inherit_brand` exists, default true. *(branding.pg.test.ts)*
- **AC-10 Shell:** tenant logo + "Powered by Merit Books" render in the rail brand area when a
  tenant logo exists; nothing changes when it doesn't. Product chrome colours unchanged.
- **AC-11 Settings UI:** loading / error / empty / populated states; upload → swatches →
  suggestions → pick → preview updates → save; manual hex with live contrast and Fix; company
  "Use tenant brand" toggle; reset with confirm.

## 10. Out of scope / follow-ups

- SVG logos (needs a vetted server-side sanitizer + rasterizer for PDFs).
- Full white-label app theming (token override behind an entitlement — see §4.1).
- Favicon / PWA icon from the square mark; custom email "from" display name per brand.
- Brand on the internal digest email (staff-facing; stays Merit).
- Nav entry for `/settings/brand` in `lib/navigation.ts` (spine file — lead).
