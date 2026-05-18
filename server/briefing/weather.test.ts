import { describe, it, expect, vi } from "vitest";
import { fetchNycWeather, __test__ } from "./weather";

function mockResp(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

describe("weather.weatherCodeToKo", () => {
  it("maps WMO codes to Korean buckets", () => {
    expect(__test__.weatherCodeToKo(0)).toBe("맑음");
    expect(__test__.weatherCodeToKo(2)).toBe("구름 조금~흐림");
    expect(__test__.weatherCodeToKo(48)).toBe("안개");
    expect(__test__.weatherCodeToKo(53)).toBe("비");
    expect(__test__.weatherCodeToKo(65)).toBe("비 (지속)");
    expect(__test__.weatherCodeToKo(75)).toBe("눈");
    expect(__test__.weatherCodeToKo(96)).toBe("뇌우");
    expect(__test__.weatherCodeToKo(999)).toBe("기타");
  });
});

describe("fetchNycWeather", () => {
  it("parses a successful Open-Meteo response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      mockResp({
        daily: {
          time: ["2026-05-16"],
          temperature_2m_max: [22.4],
          temperature_2m_min: [13.1],
          precipitation_sum: [0.3],
          weathercode: [3],
        },
      }),
    );
    const w = await fetchNycWeather({ briefingDate: "2026-05-16", fetchFn });
    expect(w).not.toBeNull();
    expect(w!.tempMaxC).toBeCloseTo(22.4);
    expect(w!.tempMinC).toBeCloseTo(13.1);
    expect(w!.precipMm).toBeCloseTo(0.3);
    expect(w!.weatherCode).toBe(3);
    expect(w!.description).toBe("구름 조금~흐림");
    expect(w!.date).toBe("2026-05-16");
  });

  it("URL includes NYC lat/lon, briefingDate, and NYC timezone", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      mockResp({
        daily: {
          time: ["2026-05-16"],
          temperature_2m_max: [10],
          temperature_2m_min: [5],
          precipitation_sum: [0],
          weathercode: [0],
        },
      }),
    );
    await fetchNycWeather({ briefingDate: "2026-05-16", fetchFn });
    const url = fetchFn.mock.calls[0]![0] as string;
    expect(url).toContain("latitude=40.7128");
    expect(url).toContain("longitude=-74.006");
    expect(url).toContain("start_date=2026-05-16");
    expect(url).toContain("end_date=2026-05-16");
    expect(url).toContain("timezone=America%2FNew_York");
  });

  it("returns null on HTTP error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResp({}, false, 500));
    const w = await fetchNycWeather({ briefingDate: "2026-05-16", fetchFn });
    expect(w).toBeNull();
  });

  it("returns null on missing daily payload", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResp({}));
    const w = await fetchNycWeather({ briefingDate: "2026-05-16", fetchFn });
    expect(w).toBeNull();
  });

  it("returns null on missing temperature value", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      mockResp({
        daily: {
          time: ["2026-05-16"],
          temperature_2m_max: [],
          temperature_2m_min: [],
          precipitation_sum: [],
          weathercode: [],
        },
      }),
    );
    const w = await fetchNycWeather({ briefingDate: "2026-05-16", fetchFn });
    expect(w).toBeNull();
  });

  it("returns null on fetch throw / abort", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const w = await fetchNycWeather({ briefingDate: "2026-05-16", fetchFn });
    expect(w).toBeNull();
  });

  it("tolerates missing precipitation/weathercode arrays (defaults to 0/맑음)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      mockResp({
        daily: {
          time: ["2026-05-16"],
          temperature_2m_max: [22],
          temperature_2m_min: [10],
        },
      }),
    );
    const w = await fetchNycWeather({ briefingDate: "2026-05-16", fetchFn });
    expect(w).not.toBeNull();
    expect(w!.precipMm).toBe(0);
    expect(w!.weatherCode).toBe(0);
    expect(w!.description).toBe("맑음");
  });
});
