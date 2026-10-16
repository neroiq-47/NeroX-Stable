import { NextResponse, type NextRequest } from "next/server";

// Geo-gating at the edge. The list comes from counsel's jurisdiction decision; the default
// covers comprehensively sanctioned jurisdictions. `?geo=XX` simulates a country in the demo.
const BLOCKED = (process.env.NEROX_BLOCKED_COUNTRIES || "CU,IR,KP,SY,RU").split(",").map((s) => s.trim().toUpperCase());

export function middleware(req: NextRequest) {
  const url = req.nextUrl;
  if (url.pathname.startsWith("/blocked")) return NextResponse.next();
  const sim = url.searchParams.get("geo")?.toUpperCase();
  const country =
    sim ||
    req.cookies.get("nerox-geo")?.value ||
    req.headers.get("x-vercel-ip-country") ||
    req.headers.get("cf-ipcountry") ||
    "";
  if (country && BLOCKED.includes(country.toUpperCase())) {
    const res = NextResponse.redirect(new URL(`/blocked?c=${country.toUpperCase()}`, req.url));
    if (sim) res.cookies.set("nerox-geo", sim, { maxAge: 600 });
    return res;
  }
  const res = NextResponse.next();
  if (sim) res.cookies.set("nerox-geo", sim, { maxAge: 600 });
  return res;
}

export const config = { matcher: ["/((?!_next|favicon|.*\\.(?:svg|png|ico)).*)"] };
