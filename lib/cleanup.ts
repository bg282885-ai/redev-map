/* ------------------------------------------------------------------ */
/*  정보몽땅 사업장 페이지에서 사업개요·위치도 읽기 (공개 화면, 키 불필요)   */
/*  cafeUrl(예: gaepo3) → 사업장 메인에서 cafeId 추출 → 사업개요/이미지     */
/* ------------------------------------------------------------------ */
import type { ProjectSummary } from "./types";

const UA = "Mozilla/5.0 (compatible; HaenglimRedevMap/1.0)";
const BASE = "https://cleanup.seoul.go.kr";
const TTL = 1000 * 60 * 60 * 24;

const g = globalThis as unknown as { __sumryCache?: Map<string, { t: number; v: ProjectSummary }> };
const cache = (g.__sumryCache ??= new Map());

async function get(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`정보몽땅 HTTP ${res.status}`);
  return res.text();
}

function clean(s: string) {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** 사업개요 표에서 의미 있는 항목만 */
const WANT = [
  "정비구역 명칭", "사업구분", "정비구역 위치", "정비구역 면적(㎡)", "조합원 수", "토지등 소유자 수", "세입자 수",
  "용도지역", "용도지구", "공공지원 대상여부", "추진위수행 여부",
];

export async function fetchProjectSummary(cafe: string): Promise<ProjectSummary> {
  const hit = cache.get(cafe);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  const main = await get(`${BASE}/cafe/mainIndx.do?cafeUrl=${encodeURIComponent(cafe)}`);
  const cafeId = main.match(/cafeId=([0-9A-Z]+)/)?.[1] ?? null;
  const out: ProjectSummary = { cafeId, fields: [], images: {}, fetchedAt: new Date().toISOString() };
  if (!cafeId) {
    cache.set(cafe, { t: Date.now(), v: out });
    return out;
  }

  const sumryUrl = `${BASE}/cafe/mastr-cleanup-bsnsSumry/execute.do?cafeId=${cafeId}&stepSeCode=102&div=`;
  const [sumry, loc, sce] = await Promise.all([
    get(sumryUrl + "sumry").catch(() => ""),
    get(sumryUrl + "locImage").catch(() => ""),
    get(sumryUrl + "sceImage").catch(() => ""),
  ]);

  // th/td 짝 (기본 정보)
  const pairs = [...sumry.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)].map(
    (m) => [clean(m[1]), clean(m[2])] as [string, string],
  );
  const seen = new Set<string>();
  for (const [k, v] of pairs) {
    if (!WANT.includes(k) || seen.has(k) || !v) continue;
    seen.add(k);
    out.fields.push([k, v.replace(/\*재건축의 경우.*$/, "").trim()]);
  }
  // 건축계획 표: 헤더 행 다음의 값 행에서 건폐율/용적률/높이/층수/세대수 추출
  const bp = sumry.match(/주용도[\s\S]*?<\/tr>\s*<tr[^>]*>([\s\S]*?)<\/tr>/);
  if (bp) {
    const cells = [...bp[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => clean(x[1]));
    // 주용도 | 대지면적 | 건축면적 | 연면적 | 건폐율 | 용적률 | 최고높이 | 층수
    const labels = ["주용도", "대지면적(㎡)", "건축면적(㎡)", "연면적(㎡)", "건폐율(%)", "용적률(%)", "최고높이(m)", "층수"];
    cells.forEach((c, i) => {
      if (labels[i] && c && c !== "0") out.fields.push([labels[i], c]);
    });
  }
  const tot = sumry.match(/분양[\s\S]*?전용면적별 세대수[\s\S]*?<\/tr>[\s\S]*?<tr[^>]*>([\s\S]*?)<\/tr>/);
  if (tot) {
    const cells = [...tot[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => clean(x[1]));
    // 대지면적 | 건축면적 | 연면적 | 동수 | 계 | 60이하 | 60~85 | 85초과
    if (cells[4]) out.fields.push(["분양 세대수(계)", cells[4]]);
    if (cells[3]) out.fields.push(["동수", cells[3]]);
  }
  const img = (html: string) => {
    const m = html.match(/<img[^>]*class="posImage"[^>]*src="([^"]+)"/) ?? html.match(/<img[^>]*src="(\/servlet\/image[^"]+)"/);
    return m ? BASE + m[1] : undefined;
  };
  out.images.loc = img(loc);
  out.images.sce = img(sce);
  cache.set(cafe, { t: Date.now(), v: out });
  return out;
}
