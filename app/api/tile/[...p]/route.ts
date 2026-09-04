import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const KEY = process.env.VWORLD_API_KEY ?? "";
const DOMAIN = process.env.VWORLD_DOMAIN ?? "localhost";
const TYPES: Record<string, string> = { Base: "png", Satellite: "jpeg", Hybrid: "png", midnight: "png", gray: "png" };

/**
 * GET /api/tile/{Base|Satellite|Hybrid}/{z}/{y}/{x}
 * V-World WMTS 프록시 — 키를 브라우저에 노출하지 않고 Referer 를 서버에서 붙인다. CDN 캐시 30일.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ p: string[] }> }) {
  const { p } = await ctx.params;
  const [type, z, y, x] = p ?? [];
  const ext = TYPES[type];
  if (!ext || ![z, y, x].every((v) => /^\d{1,7}$/.test(v ?? ""))) return new NextResponse("bad tile", { status: 400 });
  if (!KEY) return new NextResponse("no key", { status: 404 });
  const url = `https://api.vworld.kr/req/wmts/1.0.0/${KEY}/${type}/${z}/${y}/${x}.${ext}`;
  const res = await fetch(url, {
    headers: { Referer: DOMAIN.startsWith("http") ? DOMAIN : `https://${DOMAIN}/` },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const ct = res.headers.get("content-type") ?? "";
  // V-World 는 범위 밖 타일이나 키 오류를 200 + XML 로 돌려준다 → 이미지가 아니면 404
  if (!res.ok || !ct.startsWith("image/")) return new NextResponse("tile unavailable", { status: res.ok ? 404 : res.status });
  return new NextResponse(res.body, {
    headers: {
      "Content-Type": ct || `image/${ext}`,
      "Cache-Control": "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800",
    },
  });
}
