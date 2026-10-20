/** Realistic one-line descriptions a new customer might type, with the pack each must land on. */
export const CLASSIFIER_FIXTURES: Record<string, string[]> = {
  commercial_gc: [
    "We're a commercial general contractor doing ground-up and tenant improvement work, mostly on Procore.",
    'Construction manager on healthcare and education projects, GMP contracts and AIA pay applications.',
    'General contractor for office and retail buildouts. We manage subs, RFIs, submittals and owner pay apps with retainage.',
  ],
  specialty_trade: [
    'Electrical subcontractor. We work for general contractors on schools and hospitals and bill pay apps.',
    'Concrete and drywall sub; our foremen track earned hours and the GCs hold 10% retainage.',
    'Mechanical contractor doing ductwork and piping for GCs, we use Siteline for billing.',
  ],
  residential_remodel: [
    'kitchen and bath remodels, design-build',
    'We remodel homes: basements, additions and whole-home renovations. Currently on Buildertrend.',
    'Small remodeling company, homeowners pick finishes and we track allowances in JobTread.',
  ],
  home_builder: [
    'We build 10 to 15 custom homes a year on client lots, funded by construction loan draws.',
    'Spec home builder in Des Moines, moving off CoConstruct.',
    'Semi-custom homebuilder with a plan library and elevations; buyers make their selections at the design center.',
  ],
  field_service: [
    'we install and service furnaces and AC, about 12 trucks, moving off ServiceTitan',
    'Plumbing and drain cleaning company, residential service calls, using Housecall Pro.',
    "HVAC service company with maintenance agreements and a dispatch board, we're on Jobber.",
    'Heating and cooling contractor, 8 techs, flat rate price book in FieldEdge.',
  ],
  manufacturing_eto: [
    'custom cabinets and millwork, we use Innergy',
    'Cabinet shop with two CNC routers, drawings come out of Cabinet Vision.',
    'Architectural millwork and casework for commercial projects.',
    'Machine shop doing job shop work to customer drawings, running JobBOSS.',
  ],
  flooring: [
    'we sell and install carpet, LVP and hardwood',
    'Flooring store with a showroom and our own installers. We run RFMS.',
    'Floor covering retailer; we track dye lots and remnants on every order.',
  ],
  interior_design: [
    'Residential interior design firm. We charge a design fee and mark up furnishings, using Studio Designer.',
    'Interior designer doing FF&E procurement for boutique hotels.',
    'Full-service interiors: furniture, window treatments and workroom orders, every PO with a sidemark.',
  ],
  equipment_dealer: [
    'Kubota and Stihl dealer with a service shop',
    'Outdoor power equipment dealership: repair orders and warranty claims, on c-Systems today.',
    'Small engine and mower repair shop, we carry Husqvarna and Toro.',
  ],
  real_estate_development: [
    'we develop townhome lots with construction loans',
    'Real estate developer; each project is its own SPE with lender draws and an interest reserve.',
    'Multifamily development company: pro formas, investors and a capital stack on every deal.',
  ],
  professional_services: [
    'Marketing agency with retainer clients and billable hours.',
    'Management consulting firm with fixed-fee and T&M engagements, moving off Kantata.',
    'IT services and software development firm.',
  ],
  general: [
    'We run client projects in ClickUp and Smartsheet with fixed price and milestone billing.',
    'Project-based business moving from Asana and spreadsheets, fixed-price jobs with job costing.',
    'Event production company; we manage client projects on monday.com.',
  ],
};

export const GIBBERISH = ['asdf qwerty zxcv', 'lorem ipsum dolor sit amet', '!!! ??? ...', 'blorp fizzle wombat'];
