/**
 * "Weather auto" for the daily log: today's conditions at the job site from Open-Meteo (free, no
 * key, no account). Offline or failing → null and the person types it if it matters.
 */
import type { Geo, Weather } from '@/core/contract';

const WMO: ReadonlyArray<[number, string]> = [
  [0, 'Clear'], [3, 'Partly cloudy'], [48, 'Fog'], [57, 'Drizzle'], [67, 'Rain'], [77, 'Snow'], [82, 'Rain showers'], [86, 'Snow showers'], [99, 'Thunderstorm'],
];

function describe(code: number): string {
  for (const [max, word] of WMO) if (code <= max) return word;
  return 'Unsettled';
}

interface OpenMeteo {
  current?: { temperature_2m?: number; weather_code?: number; precipitation?: number };
  daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_sum?: number[] };
}

export async function weatherAt(geo: Geo): Promise<Weather | null> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat.toFixed(3)}&longitude=${geo.lng.toFixed(3)}`
    + '&current=temperature_2m,weather_code,precipitation&daily=temperature_2m_max,temperature_2m_min,precipitation_sum'
    + '&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto&forecast_days=1';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const j = (await res.json()) as OpenMeteo;
    const hi = j.daily?.temperature_2m_max?.[0];
    const lo = j.daily?.temperature_2m_min?.[0];
    const rain = j.daily?.precipitation_sum?.[0];
    return {
      conditions: j.current?.weather_code != null ? describe(j.current.weather_code) : null,
      highF: hi != null ? Math.round(hi) : null,
      lowF: lo != null ? Math.round(lo) : null,
      precipitation: rain != null && rain > 0 ? `${rain.toFixed(2)} in` : null,
      source: 'auto',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
