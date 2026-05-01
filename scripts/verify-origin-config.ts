/**
 * scripts/verify-origin-config.ts
 *
 * Pre-cutover diagnostic. Run before binding a custom domain (Task 21b /
 * SESSION_RECOVERY § Custom-domain cutover checklist). Prints what the
 * originGuard would decide for a few example Origins given the current env,
 * and emits a single "READY FOR CUSTOM DOMAIN: yes/no" line at the bottom.
 *
 * Usage:
 *   tsx scripts/verify-origin-config.ts
 *
 * Read-only and informational. Never mutates env, never exits non-zero.
 */

import { ENV } from "../server/_core/env";
import { requireSameOrigin } from "../server/originGuard";

const HOST_BAR = "─".repeat(72);

type Decision = {
  status: 200 | 403;
  reason: string;
};

/**
 * Drive the real `requireSameOrigin` middleware against a synthetic
 * Express request and capture whether it called `next()` (200) or wrote
 * a 403 with an error string. Black-box: any future change to the policy
 * is reflected here without touching this script.
 */
function decide(origin: string): Decision {
  let captured: Decision = { status: 200, reason: "next() called" };
  const req = {
    method: "POST",
    headers: { origin, host: "dropshopai-vx45nyzf.manus.space" },
    originalUrl: "/api/trpc/drafts.approve",
    protocol: "https",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const res = {
    status(code: number) {
      captured = { status: code as 403, reason: "" };
      return this;
    },
    json(body: { error: string }) {
      captured.reason = body.error;
      return this;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const next = () => {
    captured = { status: 200, reason: "allowed by policy" };
  };
  // Suppress the middleware's own rate-limited debug logs during the probe
  // — they're production telemetry, not part of the decision the diagnostic
  // is reporting. We are NOT silencing the [originGuard] fallback-used
  // production trigger log; that one fires on real traffic and is the
  // upstream signal that brings the operator to this script. (The
  // diagnostic itself doesn't run in NODE_ENV=production, so the trigger
  // wouldn't fire here anyway.)
  const realWarn = console.warn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (console as any).warn = () => {};
  try {
    // requireSameOrigin is sync (no await needed in any branch).
    requireSameOrigin(req, res, next);
  } finally {
    console.warn = realWarn;
  }
  return captured;
}

function header(title: string) {
  // eslint-disable-next-line no-console
  console.log(`\n${HOST_BAR}\n  ${title}\n${HOST_BAR}`);
}

function row(label: string, value: string) {
  // eslint-disable-next-line no-console
  console.log(`  ${label.padEnd(28)} ${value}`);
}

function main() {
  header("Origin policy diagnostic — verify-origin-config");

  const allowedRaw = ENV.allowedOrigins;
  const allowedSet = allowedRaw
    ? allowedRaw
        .split(",")
        .map((s) => s.trim().replace(/\/$/, ""))
        .filter(Boolean)
    : [];
  row("ALLOWED_ORIGINS env:", allowedRaw || "<unset — suffix fallback active>");
  if (allowedSet.length > 0) {
    row("Parsed allow-list:", allowedSet.join(", "));
  }
  row("NODE_ENV:", process.env.NODE_ENV ?? "<unset>");

  header("Effective policy (which check fires first)");
  if (allowedSet.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      "  1. EXPLICIT ALLOW-LIST is active.\n" +
        "     - Origin must be an exact-match scheme://host[:port] in the list above.\n" +
        "     - Suffix fallback (*.manus.space / *.manus.computer) is NOT consulted.\n" +
        "     - Any miss returns 403 'CSRF: Origin … is not in ALLOWED_ORIGINS'.\n",
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      "  1. SUFFIX FALLBACK is active (ADR 0003).\n" +
        "     - Any Origin whose hostname ends in .manus.space or .manus.computer is allowed.\n" +
        "     - In production (NODE_ENV=production) the fallback emits a [originGuard] fallback-used\n" +
        "       warn log on each acceptance — that warning is the trigger for this diagnostic.\n" +
        "     - Any other Origin returns 403 'CSRF: Origin is not a trusted Manus domain'.\n",
    );
  }

  header("Probes");
  const examples: Array<{ kind: string; origin: string }> = [
    { kind: "Manus deploy", origin: "https://dropshopai-vx45nyzf.manus.space" },
    { kind: "Custom domain (candidate)", origin: "https://app.visitdropshop.com" },
    { kind: "Attacker (look-alike)", origin: "https://manus.space.evil.com" },
  ];
  for (const ex of examples) {
    const d = decide(ex.origin);
    const verdict = d.status === 200 ? "ALLOW" : "DENY";
    // eslint-disable-next-line no-console
    console.log(`  [${verdict}] ${ex.kind.padEnd(28)} ${ex.origin}`);
    // eslint-disable-next-line no-console
    console.log(`         reason: ${d.reason}`);
  }

  header("Cutover readiness");
  const ready = allowedSet.length > 0;
  // eslint-disable-next-line no-console
  console.log(
    `  READY FOR CUSTOM DOMAIN: ${ready ? "yes" : "no"}\n` +
      (ready
        ? "  ALLOWED_ORIGINS is set explicitly. The suffix fallback will not\n" +
          "  be consulted; the new domain must be in the allow-list above.\n"
        : "  ALLOWED_ORIGINS is unset. The deploy is currently surviving via\n" +
          "  the suffix fallback. Set ALLOWED_ORIGINS to the canonical custom\n" +
          "  origin BEFORE flipping DNS, or every Approve will 403 the moment\n" +
          "  the deploy moves off *.manus.space.\n"),
  );

  // Diagnostic, not a CI gate. Always exit 0.
  process.exit(0);
}

main();
