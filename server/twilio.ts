/**
 * Lightweight Twilio integration. No external SDK so the demo can run
 * without `pnpm add twilio`. We just hit Twilio's REST API when LIVE_MODE.
 */

export function isLiveMode(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_PHONE_NUMBER,
  );
}

export function getDemoPhoneNumber(): string | null {
  return process.env.TWILIO_PHONE_NUMBER ?? null;
}

export async function sendSms(to: string, body: string): Promise<{ ok: boolean; sid?: string; error?: string }> {
  if (!isLiveMode()) {
    return { ok: false, error: "Live Mode disabled (Twilio creds not set)" };
  }
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  const from = process.env.TWILIO_PHONE_NUMBER!;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const params = new URLSearchParams({ To: to, From: from, Body: body });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Twilio ${res.status}: ${text.slice(0, 200)}` };
    }
    const json = (await res.json().catch(() => ({}))) as { sid?: string };
    return { ok: true, sid: json.sid };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
