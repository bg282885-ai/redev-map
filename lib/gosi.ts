/* ------------------------------------------------------------------ */
/*  구역 관련 고시·공고 수집                                              */
/*  ① 정비사업 정보몽땅 고시/공고 게시판 (서울시·자치구 등록, ~450건)        */
/*  ② 토지이음(eum.go.kr) 고시정보 — 시군구코드로 최근 N페이지             */
/*  둘 다 서버에서 제목을 통째로 받아 구역명·동 이름으로 거른다 (키 불필요)   */
/* ------------------------------------------------------------------ */
import type { GosiItem, RecentItem } from "./types";
import { guName, normName } from "./zones";
import { recentNtfc, searchNtfc, type NtfcListItem } from "./ntfc";

const UA = "Mozilla/5.0 (compatible; HaenglimRedevMap/1.0)";
const TTL = 1000 * 60 * 60 * 6;

type Raw = Omit<GosiItem, "hit" | "score">;
type Entry = { t: number; v: Raw[] };
const g = globalThis as unknown as { __gosiCache?: Map<string, Entry> };
const cache = (g.__gosiCache ??= new Map<string, Entry>());

async function cached(key: string, fn: () => Promise<Raw[]>, errors?: string[]): Promise<Raw[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  try {
    const v = await fn();
    cache.set(key, { t: Date.now(), v });
    return v;
  } catch (e) {
    errors?.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
    return hit?.v ?? [];
  }
}

/* ---------------- ① 정보몽땅 고시/공고 ---------------- */
const CLEANUP_LIST = "https://cleanup.seoul.go.kr/cleanup/bbs/lscr.do";

async function fetchCleanupPage(page: number): Promise<Raw[]> {
  const u = new URL(CLEANUP_LIST);
  u.search = new URLSearchParams({ bbsClCode: "100", cpage: String(page), pageSize: "300" }).toString();
  const res = await fetch(u, { headers: { "User-Agent": UA }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`정보몽땅 HTTP ${res.status}`);
  const html = await res.text();
  const out: Raw[] = [];
  for (const m of html.matchAll(/<li>\s*<a href="([^"]*bbs\.bbsSn=(\d+))"[\s\S]*?<\/li>/g)) {
    const block = m[0];
    const title = (block.match(/<h3 class="b-tit">([\s\S]*?)<\/h3>/)?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
    const spans = [...block.matchAll(/<span>([^<]*)<\/span>/g)].map((x) => x[1].trim());
    const pick = (label: string) => spans.find((s) => s.startsWith(label))?.split(":")[1]?.trim() ?? "";
    if (!title) continue;
    out.push({
      date: pick("등록일"),
      no: pick("번호"),
      title,
      org: pick("등록기관"),
      url: `https://cleanup.seoul.go.kr/cleanup/bbs/vscr.do?cpage=1&bbsClCode=100&bbs.bbsSn=${m[2]}`,
      source: "정보몽땅",
    });
  }
  return out;
}

export async function fetchCleanupBoard(errors?: string[]): Promise<Raw[]> {
  return cached(
    "cleanup:board",
    async () => {
      const p1 = await fetchCleanupPage(1);
      // 300건 단위 — 한 페이지가 꽉 찼으면 다음 페이지도 (cpage 는 10건 오프셋이라 31 = 300번째부터)
      const p2 = p1.length >= 300 ? await fetchCleanupPage(31).catch(() => []) : [];
      const seen = new Set<string>();
      return [...p1, ...p2].filter((x) => !seen.has(x.url) && seen.add(x.url));
    },
    errors,
  );
}

/* ---------------- ② 토지이음 고시정보 ---------------- */
const EUM_LIST = "https://www.eum.go.kr/web/gs/gv/gvGosiList.jsp";
const EUM_DET = "https://www.eum.go.kr/web/gs/gv/gvGosiDet.jsp?seq=";

async function fetchEumPage(sggCd: string, pageNo: number): Promise<Raw[]> {
  const body = new URLSearchParams({ pageNo: String(pageNo), listSize: "100", mode: "", selSggCd: sggCd });
  const res = await fetch(EUM_LIST, {
    method: "POST",
    headers: { "User-Agent": UA, Accept: "text/html,*/*", Referer: EUM_LIST, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`토지이음 HTTP ${res.status}`);
  const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
  const a = html.indexOf("<tbody");
  const b = html.indexOf("</tbody>");
  if (a < 0 || b < 0) return [];
  const out: Raw[] = [];
  for (const m of html.slice(a, b).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) =>
      x[1].replace(/<img[^>]*>/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(),
    );
    const seq = m[1].match(/seq=(\d+)/)?.[1];
    if (!seq || tds.length < 4) continue;
    out.push({ date: tds[0], no: tds[1], title: tds[2], org: tds[3], url: EUM_DET + seq, source: "토지이음" });
  }
  return out;
}

export async function fetchEum(sggCd: string, pages: number, errors?: string[]): Promise<Raw[]> {
  const lists = await Promise.all(
    Array.from({ length: pages }, (_, i) => cached(`eum:${sggCd}:${i + 1}`, () => fetchEumPage(sggCd, i + 1), errors)),
  );
  return lists.flat();
}

function ntfcToRaw(x: NtfcListItem): Raw {
  return {
    date: x.date,
    no: x.no ? `제${x.no}호` : "",
    title: x.title,
    org: x.siteCode === "11000" ? "서울특별시" : guName(x.siteCode),
    url: `https://urban.seoul.go.kr/view/html/PMNU5030110000?noticeCode=${encodeURIComponent(x.code)}`,
    source: "도시계획포털",
    code: x.code,
  };
}

/* ---------------- 최근 정비 관련 고시 (알림 패널) ---------------- */
const RECENT_RE = /정비구역|재정비촉진|재개발|재건축|주거환경|정비계획|정비사업/;
const g2 = globalThis as unknown as { __recentCache?: { t: number; v: RecentItem[] } };

export async function recentRedevNotices(days = 60): Promise<{ items: RecentItem[]; errors: string[] }> {
  const errors: string[] = [];
  const hit = g2.__recentCache;
  if (hit && Date.now() - hit.t < 1000 * 60 * 30) return { items: hit.v.filter((x) => withinDays(x.date, days)), errors };
  const [ntfc, cleanup, eum11, eum41, eum28] = await Promise.all([
    recentNtfc(100).catch((e) => {
      errors.push(`도시계획포털: ${e instanceof Error ? e.message : String(e)}`);
      return [] as NtfcListItem[];
    }),
    fetchCleanupBoard(errors),
    fetchEum("11000", 2, errors),
    fetchEum("41000", 2, errors),
    fetchEum("28000", 2, errors),
  ]);
  const items: RecentItem[] = [];
  for (const x of ntfc) if (RECENT_RE.test(x.title)) items.push({ ...ntfcToRaw(x), sido: "서울" });
  for (const x of cleanup) if (RECENT_RE.test(x.title) && /고시|지정|변경|결정/.test(x.title)) items.push({ ...x, sido: "서울" });
  for (const x of eum11) if (RECENT_RE.test(x.title)) items.push({ ...x, sido: "서울" });
  for (const x of eum41) if (RECENT_RE.test(x.title)) items.push({ ...x, sido: "경기" });
  for (const x of eum28) if (RECENT_RE.test(x.title)) items.push({ ...x, sido: "인천" });
  // 같은 고시가 여러 출처에 있으면 도시계획포털(원문 있음) 우선
  const seen = new Set<string>();
  items.sort((a, b) => b.date.localeCompare(a.date) || (a.source === "도시계획포털" ? -1 : 1));
  const out = items.filter((x) => {
    const k = `${x.date}|${normName(x.title).slice(0, 24)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  g2.__recentCache = { t: Date.now(), v: out };
  return { items: out.filter((x) => withinDays(x.date, days)), errors };
}

function withinDays(date: string, days: number) {
  const t = Date.parse(date);
  return !Number.isNaN(t) && Date.now() - t <= days * 86400_000;
}

/* ---------------- 매칭 ---------------- */
function containsToken(a: string, b: string) {
  if (b.length < 2 || a.length < b.length) return false;
  let i = a.indexOf(b);
  const digitTail = /\d/.test(b[b.length - 1]);
  const digitHead = /\d/.test(b[0]);
  while (i >= 0) {
    const next = a[i + b.length];
    const prev = a[i - 1];
    if (!(digitTail && next && /\d/.test(next)) && !(digitHead && prev && /\d/.test(prev))) return true;
    i = a.indexOf(b, i + 1);
  }
  return false;
}

export type GosiQuery = {
  /** 구역명 키워드(정규화 전) */
  names: string[];
  /** 법정동 (약한 매칭) */
  dong?: string;
  /** 시군구 코드 (토지이음 조회 범위) */
  guCode?: string | null;
  /** 시도 — 서울이면 정보몽땅 게시판·서울시 본청(11000)까지, 경기·인천은 도·시 본청 코드 */
  sido?: "서울" | "경기" | "인천";
};

export async function searchGosi(q: GosiQuery): Promise<{ items: GosiItem[]; errors: string[] }> {
  const errors: string[] = [];
  const keys = [...new Set(q.names.map(normName).filter((k) => k.length >= 2))];
  const dong = (q.dong ?? "").trim();
  const dongCore = dong.replace(/(동|가|읍|면|리)$/, "");
  const sido = q.sido ?? (q.guCode?.startsWith("41") ? "경기" : q.guCode?.startsWith("28") ? "인천" : "서울");

  const sources: Promise<Raw[]>[] = [];
  if (sido === "서울") {
    sources.push(fetchCleanupBoard(errors));
    // 서울 도시계획포털 결정고시 검색 — 구역명 키워드로 제목 검색 (최신 고시 확인용, 원문 PDF 코드 포함)
    sources.push(
      searchNtfc(keys, 15)
        .then((list) => list.map(ntfcToRaw))
        .catch((e) => {
          errors.push(`도시계획포털: ${e instanceof Error ? e.message : String(e)}`);
          return [] as Raw[];
        }),
    );
  }
  if (q.guCode) sources.push(fetchEum(q.guCode, 2, errors));
  // 시도 본청 고시 (서울 11000 · 경기 41000 · 인천 28000)
  sources.push(fetchEum(sido === "경기" ? "41000" : sido === "인천" ? "28000" : "11000", 3, errors));
  const raw = (await Promise.all(sources)).flat();

  const seen = new Set<string>();
  const items: GosiItem[] = [];
  for (const r of raw) {
    if (seen.has(r.url)) continue;
    const tn = normName(r.title);
    let score = 0;
    let hit = "";
    for (const k of keys) {
      if (containsToken(tn, k)) {
        const s = 2 + Math.min(k.length, 8) / 8;
        if (s > score) {
          score = s;
          hit = k;
        }
      }
    }
    if (!score && dongCore.length >= 2 && r.title.includes(dongCore)) {
      score = 1;
      hit = dong;
    }
    if (!score) continue;
    seen.add(r.url);
    items.push({ ...r, hit, score });
  }
  items.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
  // 동 이름만 맞는 건 최근 15건까지
  const strong = items.filter((x) => x.score >= 2);
  const weak = items.filter((x) => x.score < 2).slice(0, 15);
  return { items: [...strong, ...weak], errors };
}
