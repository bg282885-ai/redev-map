import { NextRequest, NextResponse } from "next/server";
import { searchGosi } from "@/lib/gosi";

export const runtime = "nodejs";
export const maxDuration = 60;

/** GET /api/gosi?n=구역명&n=사업장명&dong=개포동&gu=11680 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const names = sp.getAll("n").map((s) => s.trim()).filter(Boolean).slice(0, 6);
  const dong = sp.get("dong") ?? "";
  const gu = sp.get("gu");
  const sidoRaw = sp.get("sido");
  const sido = sidoRaw === "경기" || sidoRaw === "인천" || sidoRaw === "서울" ? sidoRaw : undefined;
  if (!names.length && !dong) return NextResponse.json({ items: [], errors: ["검색어 없음"] });
  const r = await searchGosi({ names, dong, guCode: gu && /^\d{5}$/.test(gu) ? gu : null, sido });
  return NextResponse.json(r, { headers: { "Cache-Control": "public, max-age=600, s-maxage=3600" } });
}
