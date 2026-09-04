import { NextRequest, NextResponse } from "next/server";
import { fetchProjectSummary } from "@/lib/cleanup";

export const runtime = "nodejs";
export const maxDuration = 60;

/** GET /api/project?cafe=gaepo3 → 정보몽땅 사업개요 */
export async function GET(req: NextRequest) {
  const cafe = (req.nextUrl.searchParams.get("cafe") ?? "").trim();
  if (!/^[\w-]{1,40}$/.test(cafe)) return NextResponse.json({ error: "cafe 파라미터 오류" }, { status: 400 });
  try {
    const v = await fetchProjectSummary(cafe);
    return NextResponse.json(v, { headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
