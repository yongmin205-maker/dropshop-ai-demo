import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireSameOrigin } from "./originGuard";

function mkReq(opts: {
  method?: string;
  origin?: string | null;
  referer?: string | null;
  host?: string;
  forwardedHost?: string;
  forwardedProto?: string;
}): any {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined && opts.origin !== null) headers.origin = opts.origin;
  if (opts.referer !== undefined && opts.referer !== null) headers.referer = opts.referer;
  if (opts.host) headers.host = opts.host;
  if (opts.forwardedHost) headers["x-forwarded-host"] = opts.forwardedHost;
  if (opts.forwardedProto) headers["x-forwarded-proto"] = opts.forwardedProto;
  return {
    method: opts.method ?? "POST",
    headers,
    protocol: "https",
  };
}

function mkRes() {
  const calls: any[] = [];
  return {
    status: vi.fn(function (this: any, code: number) {
      calls.push({ status: code });
      return this;
    }),
    json: vi.fn(function (this: any, body: any) {
      calls[calls.length - 1].body = body;
      return this;
    }),
    _calls: calls,
  };
}

describe("§5.10 requireSameOrigin", () => {
  beforeEach(() => {
    delete process.env.ALLOWED_ORIGINS;
  });
  afterEach(() => {
    delete process.env.ALLOWED_ORIGINS;
  });

  it("allows safe methods without an Origin header", () => {
    const next = vi.fn();
    const res = mkRes() as any;
    for (const m of ["GET", "HEAD", "OPTIONS"]) {
      requireSameOrigin(mkReq({ method: m }), res, next);
    }
    expect(next).toHaveBeenCalledTimes(3);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects POST with no Origin/Referer", () => {
    const next = vi.fn();
    const res = mkRes() as any;
    requireSameOrigin(mkReq({ method: "POST" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res._calls[0].body.error).toMatch(/missing Origin/);
  });

  it("rejects cross-origin POST when no allow-list configured", () => {
    const next = vi.fn();
    const res = mkRes() as any;
    requireSameOrigin(
      mkReq({
        method: "POST",
        origin: "https://attacker.example.com",
        host: "demo.manus.space",
      }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("allows same-origin POST in fallback mode", () => {
    const next = vi.fn();
    const res = mkRes() as any;
    requireSameOrigin(
      mkReq({
        method: "POST",
        origin: "https://demo.manus.space",
        host: "demo.manus.space",
      }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("honors X-Forwarded-Host (Manus prod is behind a proxy)", () => {
    const next = vi.fn();
    const res = mkRes() as any;
    requireSameOrigin(
      mkReq({
        method: "POST",
        origin: "https://dropshopai.manus.space",
        host: "internal-pod-7",
        forwardedHost: "dropshopai.manus.space",
        forwardedProto: "https",
      }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("uses Referer when Origin is absent (older browsers)", () => {
    const next = vi.fn();
    const res = mkRes() as any;
    requireSameOrigin(
      mkReq({
        method: "POST",
        referer: "https://demo.manus.space/dashboard",
        host: "demo.manus.space",
      }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("fallback policy accepts any *.manus.space Origin even when proxy rewrites Host", () => {
    const next = vi.fn();
    const res = mkRes() as any;
    requireSameOrigin(
      mkReq({
        method: "POST",
        origin: "https://dropshopai-vx45nyzf.manus.space",
        // Manus reverse proxy rewrites Host to internal Cloud-Run host:
        host: "webapp-deploy-abc123.run.internal:8080",
      }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("fallback policy accepts *.manus.computer (sandbox dev preview)", () => {
    const next = vi.fn();
    const res = mkRes() as any;
    requireSameOrigin(
      mkReq({
        method: "POST",
        origin: "https://3000-abc.us2.manus.computer",
        host: "3000-abc.us2.manus.computer",
      }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("fallback policy rejects non-Manus origins even if Host happens to match", () => {
    const next = vi.fn();
    const res = mkRes() as any;
    requireSameOrigin(
      mkReq({
        method: "POST",
        origin: "https://evil.example.com",
        host: "evil.example.com",
      }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("fallback policy rejects look-alike suffix (manus.space.evil.com)", () => {
    const next = vi.fn();
    const res = mkRes() as any;
    requireSameOrigin(
      mkReq({
        method: "POST",
        origin: "https://manus.space.evil.com",
        host: "manus.space.evil.com",
      }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("ALLOWED_ORIGINS allow-list takes precedence over same-host check", () => {
    process.env.ALLOWED_ORIGINS =
      "https://prod.manus.space,https://staging.manus.space";
    const res1 = mkRes() as any;
    const next1 = vi.fn();
    requireSameOrigin(
      mkReq({ method: "POST", origin: "https://prod.manus.space", host: "demo" }),
      res1,
      next1,
    );
    expect(next1).toHaveBeenCalledOnce();

    const res2 = mkRes() as any;
    const next2 = vi.fn();
    requireSameOrigin(
      mkReq({ method: "POST", origin: "https://demo", host: "demo" }),
      res2,
      next2,
    );
    expect(next2).not.toHaveBeenCalled();
    expect(res2.status).toHaveBeenCalledWith(403);
  });
});
