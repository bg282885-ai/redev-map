import { NextRequest, NextResponse } from "next/server";
import { fetchNtfc } from "@/lib/ntfc";

export const runtime = "nodejs";
export const maxDuration = 30;

/** GET /api/ntfc?code=11530NTC202405200001 → 결정고시 상세 (서울 도시계획포털) */
export async function GET(req: NextRequest) {
  const code = (req.nextUrl.searchParams.get("code") ?? "").trim();
  if (!/^\d{5}NTC\d{12}$/.test(code)) return NextResponse.json({ error: "code 파라미터 오류" }, { status: 400 });
  try {
    const v = await fetchNtfc(code);
    return NextResponse.json(v ?? { error: "해당 고시 없음" }, {
      status: v ? 200 : 404,
      headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
