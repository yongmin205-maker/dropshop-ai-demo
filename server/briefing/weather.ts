/**
 * server/briefing/weather.ts
 *
 * NYC weather lookup via Open-Meteo's free archive endpoint. No API
 * key required. We fetch the *historical* daily aggregate (Tmax/Tmin
 * in °C, total precipitation in mm, weathercode WMO) for the briefing
 * date, in America/New_York time.
 *
 * Dependency-injected fetcher for testability — production calls
 * Node 22's native `fetch`.
 *
 * Tolerant by design: any HTTP / parse / shape failure returns null
 * so the briefing prompt can simply omit weather context. Weather is
 * a "nice-to-have" anomaly correlator, not a critical metric.
 */
export interface WeatherSummary {
  /** Daily max temperature (Celsius). */
  tempMaxC: number;
  /** Daily min temperature (Celsius). */
  tempMinC: number;
  /** Total precipitation (mm). */
  precipMm: number;
  /** WMO weather code (https://open-meteo.com/en/docs#weathervariables) */
  weatherCode: number;
  /** Human-readable Korean condition the LLM can drop straight into prose. */
  description: string;
  /** ISO date the snapshot is for, e.g. "2026-05-16". */
  date: string;
}

const NYC_LAT = 40.7128;
const NYC_LON = -74.006;

/** Map WMO weather code to a short Korean description. We collapse
 *  the 27 WMO codes into 7 groups the owner cares about. */
function weatherCodeToKo(code: number): string {
  if (code === 0) return "맑음";
  if (code >= 1 && code <= 3) return "구름 조금~흐림";
  if (code === 45 || code === 48) return "안개";
  if ((code >= 51 && code <= 57) || (code >= 80 && code <= 82)) return "비";
  if (code >= 61 && code <= 67) return "비 (지속)";
  if (code >= 71 && code <= 77) return "눈";
  if (code >= 95 && code <= 99) return "뇌우";
  return "기타";
}

export type FetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface FetchWeatherArgs {
  briefingDate: string; // YYYY-MM-DD in NYC
  /** Inject for tests; defaults to the global `fetch`. */
  fetchFn?: FetchFn;
  /** Hard timeout, default 5000ms. We never block briefing
   *  generation more than this on weather. */
  timeoutMs?: number;
}

export async function fetchNycWeather({
  briefingDate,
  fetchFn,
  timeoutMs = 5000,
}: FetchWeatherArgs): Promise<WeatherSummary | null> {
  const f = fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  if (!f) return null;

  // Open-Meteo archive API — free, no key. Single date range = same
  // start_date / end_date.
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${NYC_LAT}` +
    `&longitude=${NYC_LON}` +
    `&start_date=${briefingDate}&end_date=${briefingDate}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode` +
    `&timezone=America%2FNew_York`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await f(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      daily?: {
        time?: string[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_sum?: number[];
        weathercode?: number[];
      };
    };
    const d = body?.daily;
    if (
      !d ||
      !Array.isArray(d.time) ||
      d.time.length === 0 ||
      typeof d.temperature_2m_max?.[0] !== "number"
    ) {
      return null;
    }
    const code = typeof d.weathercode?.[0] === "number" ? d.weathercode[0] : 0;
    return {
      tempMaxC: Number(d.temperature_2m_max[0]),
      tempMinC: typeof d.temperature_2m_min?.[0] === "number" ? d.temperature_2m_min[0] : 0,
      precipMm: typeof d.precipitation_sum?.[0] === "number" ? d.precipitation_sum[0] : 0,
      weatherCode: code,
      description: weatherCodeToKo(code),
      date: d.time[0]!,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** For tests. */
export const __test__ = { weatherCodeToKo };
