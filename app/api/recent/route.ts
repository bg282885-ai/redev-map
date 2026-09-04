import { NextRequest, NextResponse } from "next/server";
import { recentRedevNotices } from "@/lib/gosi";

export const runtime = "nodejs";
export const maxDuration = 60;

/** GET /api/recent?days=60 → 최근 정비 관련 고시 (도시계획포털·정보몽땅·토지이음 서울/경기/인천 본청) */
export async function GET(req: NextRequest) {
  const days = Math.min(180, Math.max(7, Number(req.nextUrl.searchParams.get("days")) || 60));
  const r = await recentRedevNotices(days);
  return NextResponse.json({ ...r, fetchedAt: new Date().toISOString() }, { headers: { "Cache-Control": "public, max-age=600, s-maxage=1800" } });
}
