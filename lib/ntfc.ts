/* ------------------------------------------------------------------ */
/*  서울 도시계획포털 결정고시 상세 (고시번호 코드 → 제목·고시일·고시문 파일)  */
/*  포털 화면이 쓰는 JSON(ntfc/getNtfcDt.json)을 그대로 호출한다. 키 불필요  */
/* ------------------------------------------------------------------ */

export type NtfcDetail = {
  code: string;
  title: string;
  /** 예: 2024-340 → "서울특별시고시 제2024-340호" */
  no: string;
  date: string;
  org: string;
  phone: string;
  location: string;
  content: string;
  fileUrl?: string;
  fileName?: string;
  drawings: { name: string; url: string }[];
  /** 포털 상세 페이지 */
  pageUrl: string;
};

const URBAN = "https://urban.seoul.go.kr";
const TTL = 1000 * 60 * 60 * 24;
const g = globalThis as unknown as {
  __ntfcCache?: Map<string, { t: number; v: NtfcDetail | null }>;
  __ntfcListCache?: Map<string, { t: number; v: NtfcListItem[] }>;
};
const cache = (g.__ntfcCache ??= new Map());
const listCache = (g.__ntfcListCache ??= new Map());

/* ---------------- 결정고시 목록 검색 (getNtfcList.json) ---------------- */
export type NtfcListItem = {
  code: string;
  title: string;
  no: string;
  /** YYYY-MM-DD */
  date: string;
  /** 고시 기관 시군구코드 (11000 = 서울시) */
  siteCode: string;
};

type RawListItem = { noticeCode?: string; title?: string; noticeNo?: string; noticeDate?: string; siteCode?: string };

async function fetchList(keyword: string, size: number): Promise<NtfcListItem[]> {
  const res = await fetch(`${URBAN}/ntfc/getNtfcList.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "User-Agent": "Mozilla/5.0 (compatible; HaenglimRedevMap/1.0)",
      Referer: `${URBAN}/view/html/PMNU4030100001`,
    },
    body: JSON.stringify({
      pageNo: 1, pageSize: size, keywordList: keyword ? [keyword] : [], pubSiteCode: "", organCode: "", bgnDate: "", endDate: "",
      srchType: "title", noticeCode: "",
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`도시계획포털 목록 HTTP ${res.status}`);
  const j = (await res.json()) as { content?: RawListItem[] };
  return (j.content ?? [])
    .filter((r) => r.noticeCode)
    .map((r) => ({
      code: r.noticeCode!,
      title: (r.title ?? "").replace(/\s+/g, " ").trim(),
      no: r.noticeNo ?? "",
      date: (r.noticeDate ?? "").slice(0, 10),
      siteCode: r.siteCode ?? "",
    }));
}

async function cachedList(key: string, ttl: number, fn: () => Promise<NtfcListItem[]>) {
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fn();
  listCache.set(key, { t: Date.now(), v });
  return v;
}

/** 제목에 키워드가 들어간 결정고시 (최신순). 키워드마다 한 번씩 조회해 합친다 */
export async function searchNtfc(keywords: string[], size = 15): Promise<NtfcListItem[]> {
  const kws = [...new Set(keywords.map((k) => k.trim()).filter((k) => k.length >= 2))].slice(0, 3);
  const lists = await Promise.all(kws.map((k) => cachedList(`s:${k}`, 1000 * 60 * 60 * 6, () => fetchList(k, size)).catch(() => [] as NtfcListItem[])));
  const seen = new Set<string>();
  return lists.flat().filter((x) => !seen.has(x.code) && seen.add(x.code)).sort((a, b) => b.date.localeCompare(a.date));
}

/** 최근 결정고시 전체 (최신순) */
export async function recentNtfc(size = 80): Promise<NtfcListItem[]> {
  return cachedList(`recent:${size}`, 1000 * 60 * 60, () => fetchList("", size));
}

type RawImage = { aImagePath?: string; aImageName?: string; dImagePath?: string; dImageName?: string };
type Raw = {
  noticeCode?: string;
  title?: string;
  noticeNo?: string;
  noticeDate?: string;
  site?: string;
  phone?: string;
  content?: string;
  tnNtfcImage?: RawImage | null;
  tnDrwImage?: RawImage[] | null;
  planPrjctPub?: { location?: string } | null;
};

function fileUrl(path?: string, name?: string) {
  if (!path || !name) return undefined;
  return `${URBAN}/${path.replace(/^\/+/, "")}/${encodeURIComponent(name)}`;
}

export async function fetchNtfc(code: string): Promise<NtfcDetail | null> {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const res = await fetch(`${URBAN}/ntfc/getNtfcDt.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "User-Agent": "Mozilla/5.0 (compatible; HaenglimRedevMap/1.0)",
      Referer: `${URBAN}/view/html/PMNU4030100001`,
    },
    body: JSON.stringify({ noticeCode: code, statusCode: "" }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`도시계획포털 HTTP ${res.status}`);
  const j = (await res.json()) as Raw;
  let v: NtfcDetail | null = null;
  if (j && j.noticeCode && (j.title || j.noticeNo)) {
    v = {
      code,
      title: (j.title ?? "").trim(),
      no: j.noticeNo ?? "",
      date: (j.noticeDate ?? "").slice(0, 10),
      org: j.site ?? "",
      phone: j.phone ?? "",
      location: j.planPrjctPub?.location ?? "",
      content: (j.content ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
      fileUrl: fileUrl(j.tnNtfcImage?.aImagePath, j.tnNtfcImage?.aImageName),
      fileName: j.tnNtfcImage?.aImageName,
      drawings: (j.tnDrwImage ?? [])
        .map((d) => ({ name: d.dImageName ?? "", url: fileUrl(d.dImagePath, d.dImageName) ?? "" }))
        .filter((d) => d.url),
      pageUrl: `${URBAN}/view/html/PMNU5030110000?noticeCode=${encodeURIComponent(code)}`,
    };
  }
  cache.set(code, { t: Date.now(), v });
  return v;
}
