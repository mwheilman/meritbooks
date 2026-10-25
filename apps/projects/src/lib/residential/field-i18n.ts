/**
 * Labels for the lead carpenter's "Today" site card (RES-68) in English and Spanish. The phone app
 * shows the language the person chose; the API sends both so an offline device can switch.
 * Pure and client-safe.
 */

export const FIELD_LANGS = ['en', 'es'] as const;
export type FieldLang = (typeof FIELD_LANGS)[number];

export const SITE_LABEL_KEYS = [
  'today', 'clockIn', 'clockOut', 'address', 'lockbox', 'gate', 'garage', 'alarm', 'homeowner', 'occupied', 'pets', 'children', 'workHours',
  'parking', 'offLimits', 'crewBathroom', 'tempKitchen', 'deliveries', 'checks', 'tasks', 'rrp', 'receipt', 'noDeliveries', 'navigate',
] as const;
export type SiteLabelKey = (typeof SITE_LABEL_KEYS)[number];

export const SITE_LABELS: Readonly<Record<FieldLang, Readonly<Record<SiteLabelKey, string>>>> = {
  en: {
    today: 'Today', clockIn: 'Clock in', clockOut: 'Clock out', address: 'Address', lockbox: 'Lockbox code', gate: 'Gate code', garage: 'Garage code',
    alarm: 'Alarm code', homeowner: 'Homeowner notes', occupied: 'People live here — protect and clean daily', pets: 'Pets', children: 'Children',
    workHours: 'Work hours', parking: 'Parking', offLimits: 'Off limits', crewBathroom: 'Crew bathroom', tempKitchen: 'Temporary kitchen',
    deliveries: 'Deliveries', checks: 'Checks to do', tasks: 'Tasks', rrp: 'Lead-safe rules apply (pre-1978 home)', receipt: 'Snap a receipt',
    noDeliveries: 'No deliveries today', navigate: 'Navigate',
  },
  es: {
    today: 'Hoy', clockIn: 'Marcar entrada', clockOut: 'Marcar salida', address: 'Dirección', lockbox: 'Código de la caja de llaves', gate: 'Código del portón',
    garage: 'Código del garaje', alarm: 'Código de la alarma', homeowner: 'Notas del dueño', occupied: 'La casa está habitada — proteger y limpiar a diario',
    pets: 'Mascotas', children: 'Niños', workHours: 'Horario de trabajo', parking: 'Estacionamiento', offLimits: 'Prohibido entrar', crewBathroom: 'Baño para el equipo',
    tempKitchen: 'Cocina temporal', deliveries: 'Entregas', checks: 'Revisiones pendientes', tasks: 'Tareas', rrp: 'Aplican reglas de plomo (casa anterior a 1978)',
    receipt: 'Tomar foto del recibo', noDeliveries: 'No hay entregas hoy', navigate: 'Navegar',
  },
};

export function siteLabels(lang: string | null | undefined): Readonly<Record<SiteLabelKey, string>> {
  return lang === 'es' ? SITE_LABELS.es : SITE_LABELS.en;
}
