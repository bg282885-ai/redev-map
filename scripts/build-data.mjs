/* ------------------------------------------------------------------ */
/*  데이터 빌드 스크립트                                                  */
/*  1) 서울 열린데이터광장 「의제처리구역 위치정보」(UQ181) SHP → GeoJSON     */
/*  2) 정비사업 정보몽땅 사업장 목록(자치구별) 수집                         */
/*  3) 대표지번 지오코딩(V-World) + 구역 폴리곤 결합                        */
/*  → public/data/zones.geojson, public/data/projects.json                */
/*                                                                        */
/*  실행: npm run build:data  (V-World 키는 .env.local 의 VWORLD_API_KEY)  */
/*  원본·중간 산출물은 data/raw/ 에 캐시되어 재실행이 빠르다.                 */
/* ------------------------------------------------------------------ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import mapshaper from "mapshaper";
import { DONE_RAW, stageGroup } from "../lib/stage.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RAW = path.join(ROOT, "data", "raw");
export const OUT = path.join(ROOT, "public", "data");
fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

loadEnv();
/** 출처별 자료 기준 (meta.json 에 기록 → 화면의 "자료 기준" 표시) */
const SOURCE_INFO = { seoulShp: "", cleanup: "", gyeonggi: "", incheon: "", portal: "" };
const VWORLD_KEY = process.env.VWORLD_API_KEY ?? "";
const VWORLD_DOMAIN = process.env.VWORLD_DOMAIN ?? "localhost";
const UA = "Mozilla/5.0 (compatible; HaenglimRedevMap/1.0)";

/** 서울 자치구 코드 (정보몽땅 signguCode = 법정동 시군구코드 5자리) */
export const GU = {
  11110: "종로구", 11140: "중구", 11170: "용산구", 11200: "성동구", 11215: "광진구",
  11230: "동대문구", 11260: "중랑구", 11290: "성북구", 11305: "강북구", 11320: "도봉구",
  11350: "노원구", 11380: "은평구", 11410: "서대문구", 11440: "마포구", 11470: "양천구",
  11500: "강서구", 11530: "구로구", 11545: "금천구", 11560: "영등포구", 11590: "동작구",
  11620: "관악구", 11650: "서초구", 11680: "강남구", 11710: "송파구", 11740: "강동구",
};
const GU_CODE = Object.fromEntries(Object.entries(GU).map(([c, n]) => [n, c]));

/* ------------------------------------------------------------------ */
/*  1. 의제처리구역 SHP → GeoJSON                                         */
/* ------------------------------------------------------------------ */
const SHP_PROJ =
  "+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 " +
  "+ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43";

/** 열린데이터광장 데이터셋 페이지에서 최신 파일 순번과 이름을 읽는다 (downloadFile('9') 중 가장 큰 번호) */
async function latestShpInfo(infId = "OA-20957") {
  try {
    const html = await (await fetch(`https://data.seoul.go.kr/dataList/${infId}/F/1/datasetView.do`, { headers: { "User-Agent": UA } })).text();
    const files = [...html.matchAll(/title="([^"]+\.zip)"[^>]*onclick="javascript:downloadFile\('(\d+)'\)/g)].map((m) => ({ name: m[1], seq: +m[2] }));
    files.sort((a, b) => b.seq - a.seq);
    return files[0] ?? null;
  } catch {
    return null;
  }
}

async function downloadShp() {
  const info = process.env.SEOUL_UQ181_SEQ ? { seq: +process.env.SEOUL_UQ181_SEQ, name: `seq${process.env.SEOUL_UQ181_SEQ}.zip` } : await latestShpInfo();
  const seq = String(info?.seq ?? 9);
  const zip = path.join(RAW, `uq181_${seq}.zip`);
  SOURCE_INFO.seoulShp = info?.name ?? `seq ${seq}`;
  if (!fs.existsSync(zip) || fs.statSync(zip).size < 100_000) {
    console.log(`· 의제처리구역 SHP 내려받기 (서울 열린데이터광장 OA-20957, ${SOURCE_INFO.seoulShp})`);
    const res = await fetch("https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?&useCache=false", {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ infId: "OA-20957", seq, infSeq: "1", useCache: "false" }),
    });
    if (!res.ok) throw new Error(`SHP 다운로드 실패 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 2).toString() !== "PK") throw new Error("SHP 응답이 zip이 아님");
    fs.writeFileSync(zip, buf);
  }
  const dir = path.join(RAW, `uq181_${seq}`);
  if (!findFile(dir, ".shp")) {
    fs.mkdirSync(dir, { recursive: true });
    new AdmZip(zip).extractAllTo(dir, true);
  }
  const shp = findFile(dir, ".shp");
  if (!shp) throw new Error("zip 안에 .shp 없음");
  return shp;
}

/**
 * 서울시 지구단위계획구역(특별계획구역) 공간정보 — 열린데이터광장 OA-21164, UQ165 SHP(EPSG:5174, euc-kr), 월간, 공공누리 1유형.
 * 압구정 3~5구역처럼 정비구역은 아직 없지만 지구단위계획의 특별계획구역으로 경계가 정해진 재건축·재개발 단지의 경계로 쓴다
 * (2026-09-08, 아실 비교 후 추가). 실패하면 이전 zones.geojson 의 src "special" 을 유지한다.
 */
async function downloadSpecialShp() {
  const info = process.env.SEOUL_UQ165_SEQ ? { seq: +process.env.SEOUL_UQ165_SEQ, name: `seq${process.env.SEOUL_UQ165_SEQ}.zip` } : await latestShpInfo("OA-21164");
  if (!info) throw new Error("OA-21164 파일 목록을 읽지 못함");
  const seq = String(info.seq);
  const zip = path.join(RAW, `uq165_${seq}.zip`);
  SOURCE_INFO.seoulSpecial = info.name;
  if (!fs.existsSync(zip) || fs.statSync(zip).size < 10_000) {
    console.log(`· 특별계획구역 SHP 내려받기 (서울 열린데이터광장 OA-21164, ${info.name})`);
    // 데이터셋마다 숨은 필드(infSeq 등)가 달라 페이지의 frmFile 폼 값을 그대로 쓴다 (OA-21164 는 infSeq=2 — 1 로 보내면 "잘못된 접근")
    const page = await (await fetch("https://data.seoul.go.kr/dataList/OA-21164/F/1/datasetView.do", { headers: { "User-Agent": UA } })).text();
    const form = page.match(/<form[^>]*name="frmFile"[\s\S]*?<\/form>/)?.[0] ?? "";
    const fields = Object.fromEntries(
      [...form.matchAll(/<input[^>]*>/g)]
        .map((m) => [m[0].match(/name="([^"]+)"/)?.[1], m[0].match(/value="([^"]*)"/)?.[1] ?? ""])
        .filter((x) => x[0]),
    );
    const body = new URLSearchParams({ infId: "OA-21164", infSeq: "2", useCache: "false", ...fields, seq });
    const res = await fetch("https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?&useCache=false", {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Referer: "https://data.seoul.go.kr/dataList/OA-21164/F/1/datasetView.do" },
      body,
    });
    if (!res.ok) throw new Error(`특별계획구역 SHP 다운로드 실패 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 2).toString() !== "PK") throw new Error("특별계획구역 SHP 응답이 zip이 아님");
    fs.writeFileSync(zip, buf);
  }
  const dir = path.join(RAW, `uq165_${seq}`);
  if (!findFile(dir, ".shp")) {
    fs.mkdirSync(dir, { recursive: true });
    new AdmZip(zip).extractAllTo(dir, true);
  }
  const shp = findFile(dir, ".shp");
  if (!shp) throw new Error("특별계획구역 zip 안에 .shp 없음");
  return shp;
}

/** 특별계획구역 폴리곤 전부 (연결 단계에서 필요한 것만 zones 에 넣는다) */
async function buildSpecialZones() {
  try {
    const shp = await downloadSpecialShp();
    const tmp = path.join(RAW, "special_raw.geojson");
    const q = (s) => `"${s.replace(/\\/g, "/")}"`;
    await mapshaper.runCommands(`-i ${q(shp)} encoding=euc-kr -proj from="${SHP_PROJ}" crs=wgs84 -simplify interval=1 keep-shapes -o ${q(tmp)} format=geojson precision=0.000001`);
    const raw = JSON.parse(fs.readFileSync(tmp, "utf8"));
    const out = raw.features
      .filter((f) => f.geometry)
      .map((f) => {
        const p = f.properties;
        return {
          type: "Feature",
          geometry: f.geometry,
          properties: {
            fid: `S${p.PRESENT_SN ?? p.OBJECTID ?? Math.random().toString(36).slice(2)}`, id: p.WTNNC_SN ?? "", name: (p.DGM_NM ?? "").trim(), code: "UQ1650",
            gu: p.SIGNGU_SE ?? "11000", area: Math.round(+p.DGM_AR || areaM2(f.geometry)), ntfc: p.NTFC_SN ?? "", bbox: bbox(f.geometry), sido: "서울", src: "special",
          },
        };
      });
    console.log(`  특별계획구역 ${out.length}개`);
    return out;
  } catch (e) {
    console.warn("  특별계획구역 자료 실패:", e.message.slice(0, 80), "→ 이전 자료 유지");
    return null;
  }
}

/**
 * 정비구역 폴리곤이 없는 재건축·재개발 사업장의 대표지번이 특별계획구역 안에 있으면 그 경계를 쓴다 (필지 폴백보다 먼저).
 * 이름 숫자가 다르면(특별계획구역3 안에 4구역 사업장) 건너뛴다. 큰 특별계획구역(40만㎡ 이상)은 여러 단지를 덮으므로 제외.
 */
function linkSpecialZones(projects, zones, specials, prevZones) {
  const prevSpecial = new Map((prevZones?.features ?? []).filter((f) => f.properties?.src === "special").map((f) => [f.properties.fid, f]));
  const pool = specials ?? [...prevSpecial.values()];
  if (!pool.length) return 0;
  const added = new Map();
  let n = 0;
  for (const p of projects) {
    if (p.zoneFid || p.stale || p.lat == null || p.lng == null || (p.sido ?? "서울") !== "서울") continue;
    const kc = kindClass(p.kind);
    // 재건축·소규모재건축과 도심 도시정비형 재개발만 (주택정비형 재개발은 역세권 활성화 등 무관한 특별계획구역에 걸릴 수 있음)
    if (!(kc === "rebuild" || kc === "small" || (kc === "redev" && /도시정비형|도시환경|역세권/.test(p.kind + p.name)))) continue;
    const pt = [p.lng, p.lat];
    const pn = normName(p.name);
    const hits = pool.filter((z) => {
      const b = z.properties.bbox;
      if (z.properties.area > 400000) return false;
      if (!(pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3] && pointInGeom(pt, z.geometry))) return false;
      return !digitsConflict(pn, normName(z.properties.name));
    });
    if (!hits.length) continue;
    hits.sort((a, b) => a.properties.area - b.properties.area); // 가장 작은(구체적인) 특별계획구역
    const z = hits[0];
    if (!added.has(z.properties.fid)) {
      const code = kc === "rebuild" ? "UQ1240" : kc === "small" ? "UQ1270" : "UQ1221";
      added.set(z.properties.fid, { ...z, properties: { ...z.properties, code, gu: p.guCode ?? z.properties.gu } });
    }
    p.zoneFid = z.properties.fid;
    p.zoneId = z.properties.id || z.properties.fid;
    p.zoneHow = "special";
    n++;
  }
  zones.push(...added.values());
  console.log(`· 특별계획구역 경계로 연결 ${n}건 (구역 ${added.size}개${specials ? "" : ", 이전 자료"})`);
  return n;
}

function findFile(dir, ext) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = findFile(p, ext);
      if (r) return r;
    } else if (e.name.toLowerCase().endsWith(ext)) return p;
  }
  return null;
}

async function buildZones(shp) {
  // 단순화는 허용오차 1 m (예전 10% 비율 단순화는 꼭짓점의 23%만 남겨 확대하면 경계가 각져 보였다 — 2026-09-08 부팀장 지적)
  console.log("· SHP → GeoJSON 변환 (EPSG:5174 → WGS84, 1 m 허용오차 단순화)");
  const tmp = path.join(RAW, "zones_raw.geojson");
  const q = (s) => `"${s.replace(/\\/g, "/")}"`;
  await mapshaper.runCommands(
    `-i ${q(shp)} encoding=euc-kr -filter "/^UQ(11|12|51)/.test(ATRB_SE)" ` +
      `-proj from="${SHP_PROJ}" crs=wgs84 -simplify interval=1 keep-shapes ` +
      `-o ${q(tmp)} format=geojson precision=0.000001`,
  );
  const raw = JSON.parse(fs.readFileSync(tmp, "utf8"));
  // 원본에 같은 도형번호가 두 번 들어있는 경우가 있다(대부분 완전 복제). 이름까지 같으면 하나만 남기고,
  // 이름이 다른 드문 경우는 도형번호 뒤에 -2 를 붙여 둘 다 살린다
  const seenKey = new Set();
  const fidCount = new Map();
  raw.features = raw.features.filter((f) => {
    const k = `${f.properties.PRESENT_SN}|${f.properties.DGM_NM}`;
    if (seenKey.has(k)) return false;
    seenKey.add(k);
    const n = (fidCount.get(f.properties.PRESENT_SN) ?? 0) + 1;
    fidCount.set(f.properties.PRESENT_SN, n);
    if (n > 1) f.properties.PRESENT_SN = `${f.properties.PRESENT_SN}-${n}`;
    return true;
  });
  const features = raw.features.map((f) => {
    const p = f.properties;
    const bb = bbox(f.geometry);
    return {
      type: "Feature",
      geometry: f.geometry,
      properties: {
        fid: p.PRESENT_SN, // 도형번호 (고유)
        id: p.WTNNC_SN, // 결정고시(조서) 관리코드 — 정보몽땅 지도 코드와 동일 체계
        name: (p.DGM_NM ?? "").trim(),
        code: p.ATRB_SE, // 최종 분류코드 (UQ1221 주택정비형 재개발구역 …)
        gu: p.SIGNGU_SE, // 시군구코드 (11000=시 본청)
        area: Math.round(p.DGM_AR ?? 0),
        ntfc: p.NTFC_SN ?? "", // 고시번호 코드 (11000NTC + yyyymmdd + 순번)
        bbox: bb.map((v) => +v.toFixed(6)),
      },
    };
  });
  features.sort((a, b) => a.properties.id.localeCompare(b.properties.id));
  console.log(`  서울 구역 ${features.length}개`);
  return features;
}

/* ------------------------------------------------------------------ */
/*  2. 정보몽땅 사업장 목록                                               */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/*  정보몽땅 고시/공고 게시판 → 사업장별 최근 동향 한 줄 (지도 라벨 "한남3 · 이주" 용, 아실 desc 방식)   */
/* ------------------------------------------------------------------ */
const NOTE_KW = [
  [/시공(자|사)\s*선정/, "시공사 선정"], [/이주/, "이주"], [/철거/, "철거"], [/착공/, "착공"],
  [/입주자\s*모집|일반분양|분양공고|분양/, "분양"], [/관리처분/, "관리처분"], [/사업시행/, "사업시행인가"],
  [/조합설립/, "조합설립"], [/추진위원회|추진위/, "추진위"], [/정비구역|정비계획/, "정비구역·계획"], [/안전진단/, "안전진단"],
  [/총회/, "총회"], [/준공|이전고시/, "준공"], [/해산|청산/, "청산"], [/후보지/, "후보지"], [/시행자\s*지정/, "시행자 지정"],
  [/공람|열람/, "공람"], [/수의계약|입찰/, "입찰"],
];
function noteKeyword(title) {
  for (const [re, kw] of NOTE_KW) if (re.test(title)) return kw;
  return null;
}

async function fetchCleanupBoardPage(page) {
  const u = new URL("https://cleanup.seoul.go.kr/cleanup/bbs/lscr.do");
  u.search = new URLSearchParams({ bbsClCode: "100", cpage: String(page), pageSize: "300" }).toString();
  const html = await (await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) })).text();
  const out = [];
  for (const m of html.matchAll(/<li>\s*<a href="([^"]*bbs\.bbsSn=(\d+))"[\s\S]*?<\/li>/g)) {
    const block = m[0];
    const title = (block.match(/<h3 class="b-tit">([\s\S]*?)<\/h3>/)?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
    const spans = [...block.matchAll(/<span>([^<]*)<\/span>/g)].map((x) => x[1].trim());
    const pick = (label) => spans.find((s) => s.startsWith(label))?.split(":")[1]?.trim() ?? "";
    if (!title) continue;
    out.push({ date: pick("등록일"), title, url: `https://cleanup.seoul.go.kr/cleanup/bbs/vscr.do?cpage=1&bbsClCode=100&bbs.bbsSn=${m[2]}` });
  }
  return out;
}

/** 정보몽땅 고시/공고 최근 600건 (하루 캐시). 실패하면 이전 캐시, 그것도 없으면 빈 배열 */
async function fetchCleanupBoard() {
  const cache = path.join(RAW, "cleanup-board.json");
  const fresh = fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < 1000 * 60 * 60 * 24;
  if (fresh && !process.env.FORCE) return JSON.parse(fs.readFileSync(cache, "utf8"));
  try {
    const p1 = await fetchCleanupBoardPage(1);
    const p2 = p1.length >= 300 ? await fetchCleanupBoardPage(31).catch(() => []) : [];
    const seen = new Set();
    const out = [...p1, ...p2].filter((x) => !seen.has(x.url) && seen.add(x.url));
    if (out.length) fs.writeFileSync(cache, JSON.stringify(out));
    console.log(`· 정보몽땅 고시/공고 ${out.length}건 (최근 동향용)`);
    return out;
  } catch (e) {
    console.warn("  정보몽땅 게시판 실패:", e.message.slice(0, 60));
    return fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, "utf8")) : [];
  }
}

/** 사업장의 최근 동향: 서울은 게시판에서 구역명이 들어간 최신 글, 경기는 추진현황의 최신 인가 일자 */
export function noteFor(p, board) {
  if (p.sido === "경기") {
    let best = null;
    for (const [k, v] of p.extra ?? []) {
      const dates = String(v).match(/\d{4}-\d{2}-\d{2}/g);
      if (!dates || /담당|조합원|소유자|용적률/.test(k)) continue;
      const d = dates[dates.length - 1];
      if (!best || d > best.date) best = { date: d, kw: k, src: "경기도" };
    }
    return best;
  }
  if (p.sido !== "서울" || !board.length) return null;
  const key = normName(p.name);
  if (key.length < 2) return null;
  let best = null;
  for (const b of board) {
    if (!b.date || !containsToken(normName(b.title), key)) continue;
    if (!best || b.date > best.date) best = b;
  }
  return best ? { date: best.date, kw: noteKeyword(best.title) ?? "공고", title: best.title, url: best.url, src: "정보몽땅" } : null;
}

async function fetchCleanupList() {
  const cache = path.join(RAW, "cleanup-list.json");
  const maxAge = 1000 * 60 * 60 * 24 * 3;
  if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < maxAge && !process.env.FORCE) {
    SOURCE_INFO.cleanup = new Date(fs.statSync(cache).mtimeMs).toISOString().slice(0, 10);
    return JSON.parse(fs.readFileSync(cache, "utf8"));
  }
  SOURCE_INFO.cleanup = new Date().toISOString().slice(0, 10);
  console.log("· 정보몽땅 사업장 목록 수집 (자치구 25개)");
  // 정보몽땅이 간헐적으로 특정 자치구에 빈 목록을 돌려준다(2026-09-08 광진구 20건이 통째로 빠짐) → 그 구는 이전 목록 유지
  const prevList = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, "utf8")) : [];
  for (const p of readJson(path.join(OUT, "projects.json")) ?? []) {
    if (p.sido === "서울" && !prevList.some((q) => q.no === p.no)) {
      const { no, gu, kind, name, jibun, stage, docs, cafe, map } = p;
      prevList.push({ no, gu, kind, name, jibun, stage, docs, cafe, map });
    }
  }
  const out = [];
  for (const [code, name] of Object.entries(GU)) {
    // 자치구별 목록의 번호는 그 목록 안에서만 유일 → 사업장 id 는 자치구코드+번호 로 만든다
    const seen = new Set();
    // pageSize=300 은 동작하지만 cpage 는 10건 단위 오프셋으로 계산되므로 자치구별로 한 번에 받는다
    const url = new URL("https://cleanup.seoul.go.kr/cleanup/bsnssttus/lscrMainIndx.do");
    url.search = new URLSearchParams({ "scupBsnsSttus.signguCode": code, cpage: "1", pageSize: "300" }).toString();
    let rows = [];
    // 연속 요청 시 빈 목록이 오는 경우가 있어 재시도
    for (let attempt = 1; attempt <= 4; attempt++) {
      const html = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
      rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]).filter((r) => /<td>\d+<\/td>/.test(r));
      if (rows.length) break;
      await sleep(1500 * attempt);
    }
    await sleep(400);
    if (!rows.length) {
      const keep = prevList.filter((p) => Math.floor(p.no / 1000) === +code);
      if (keep.length) {
        console.warn(`  ! ${name}: 빈 목록 응답 → 이전 자료 ${keep.length}건 유지`);
        out.push(...keep);
        continue;
      }
    }
    let n = 0;
    for (const r of rows) {
      const tds = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) =>
        x[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(),
      );
      const perGuNo = +tds[0];
      if (!perGuNo || seen.has(perGuNo)) continue;
      seen.add(perGuNo);
      n++;
      out.push({
        no: +code * 1000 + perGuNo,
        gu: tds[1] || name,
        kind: tds[2],
        name: tds[3],
        jibun: tds[4],
        stage: tds[5],
        docs: tds[6],
        cafe: r.match(/cafeOpenPopup\('([^']*)'\)/)?.[1] ?? null,
        map: r.match(/mapOpenPopup\('([^']*)'\)/)?.[1] ?? null,
      });
    }
    process.stdout.write(`  ${name} ${n}건\n`);
    if (rows.length >= 300) console.warn(`  ! ${name}: 300건 초과 가능성 — 페이지 분할 필요`);
  }
  out.sort((a, b) => a.no - b.no);
  fs.writeFileSync(cache, JSON.stringify(out));
  return out;
}

/* ------------------------------------------------------------------ */
/*  3. 지오코딩 (V-World getcoord, 지번)                                   */
/* ------------------------------------------------------------------ */
const geoCachePath = path.join(RAW, "geocode.json");
export const geoCache = fs.existsSync(geoCachePath) ? JSON.parse(fs.readFileSync(geoCachePath, "utf8")) : {};
// V-World 는 해외 IP(GitHub Actions 러너 등)에 HTML 차단 페이지를 돌려준다. 연속 실패하면 차단으로 보고
// 남은 지오코딩을 건너뛴다(주소당 15초씩 재시도하면 수천 건에 몇 시간이 걸림). 좌표는 캐시·이전 자료로 유지
let vworldFails = 0;
let vworldDown = false;

export async function geocode(address, type = "PARCEL") {
  const ck = type === "ROAD" ? `ROAD:${address}` : address;
  if (ck in geoCache) return geoCache[ck];
  if (!VWORLD_KEY || vworldDown) return null;
  const u = new URL("https://api.vworld.kr/req/address");
  u.search = new URLSearchParams({
    service: "address", request: "getcoord", version: "2.0", crs: "EPSG:4326", type,
    format: "json", key: VWORLD_KEY, refine: "true", simple: "false", address,
  }).toString();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const j = await (await fetch(u, { headers: { Referer: `https://${VWORLD_DOMAIN}/`, "User-Agent": UA } })).json();
      const p = j.response?.result?.point;
      const v = p ? { lng: +(+p.x).toFixed(6), lat: +(+p.y).toFixed(6) } : null;
      geoCache[ck] = v;
      vworldFails = 0;
      await sleep(70); // 연속 호출 시 차단 방지
      return v;
    } catch (e) {
      // 잠시 차단되면 HTML 이 오거나 fetch 가 실패한다 → 쉬었다가 재시도
      if (attempt === 3) {
        console.warn("  지오코딩 오류", address, e.message);
        if (++vworldFails >= 3) {
          vworldDown = true;
          console.warn("  V-World 응답이 계속 실패(해외 IP 차단?) → 남은 지오코딩 생략, 캐시·이전 좌표 사용");
        }
      }
      await sleep(2500 * attempt);
    }
  }
  return null;
}

/**
 * 장소(POI) 검색 폴백 — V-World search(type=place). 위치 열이 비어 있거나("경기도 광명시 nan") 준공 후 지번이
 * 합병되어 지오코딩이 안 되는 아파트 단지(하안주공5단지·철산주공13단지 등)를 단지명으로 찾는다.
 * 결과는 같은 시군구 안에 있고 제목이 단지명을 포함하는 것만 받는다(정류장·경로당·상가 등 부속시설은 뒤로).
 */
const PLACE_NOISE = /(정류장|버스|입구|출입구|정문|후문|경비실|경로당|노인정|관리소|관리사무소|상가|어린이집|유치원|학교|주차장|사거리|삼거리|민방위)/;
/** 장소 검색 후보 지점들 (점수순, 최대 4개) — 경비실·입구 지점은 도로 필지에 떨어지기도 해서 필지 조회는 차례로 시도한다 */
async function searchPlaceItems(query, sidoFull, gu, core) {
  const ck = `PLACES:${query}`;
  if (ck in geoCache) return geoCache[ck];
  if (!VWORLD_KEY || vworldDown) return [];
  const u = new URL("https://api.vworld.kr/req/search");
  u.search = new URLSearchParams({
    service: "search", request: "search", version: "2.0", crs: "EPSG:4326", size: "10", page: "1",
    query, type: "place", format: "json", errorformat: "json", key: VWORLD_KEY,
  }).toString();
  const head = `${sidoFull} ${gu.split(" ")[0]}`;
  const norm = (s) => (s ?? "").replace(/\(.*?\)/g, "").replace(/아파트|APT|\s|[·,.\-]/gi, "");
  const c = norm(core);
  try {
    const j = await (await fetch(u, { headers: { Referer: `https://${VWORLD_DOMAIN}/`, "User-Agent": UA } })).json();
    const items = (j.response?.result?.items ?? []).filter((it) => {
      const addr = it.address?.parcel ?? it.address?.road ?? "";
      if (addr && !addr.startsWith(head)) return false; // 주소가 비어 있는 항목(단지 대표점)은 통과
      const t = norm(it.title);
      return c.length >= 3 && (t.includes(c) || c.includes(t));
    });
    const score = (it) => (norm(it.title) === c ? 4 : 0) + (PLACE_NOISE.test(it.title) ? 0 : 2) + (it.title.includes("/") ? 0 : 1);
    items.sort((a, b) => score(b) - score(a));
    const v = items.filter((it) => it.point).slice(0, 4).map((it) => ({ lng: +(+it.point.x).toFixed(6), lat: +(+it.point.y).toFixed(6), title: it.title }));
    geoCache[ck] = v;
    vworldFails = 0;
    await sleep(70);
    return v;
  } catch (e) {
    console.warn("  장소 검색 오류", query, e.message);
    if (++vworldFails >= 3) vworldDown = true;
    return [];
  }
}
async function searchPlace(query, sidoFull, gu, core) {
  const ck = `PLACE:${query}`;
  if (ck in geoCache) return geoCache[ck];
  if (!VWORLD_KEY || vworldDown) return null;
  const u = new URL("https://api.vworld.kr/req/search");
  u.search = new URLSearchParams({
    service: "search", request: "search", version: "2.0", crs: "EPSG:4326", size: "10", page: "1",
    query, type: "place", format: "json", errorformat: "json", key: VWORLD_KEY,
  }).toString();
  const head = `${sidoFull} ${gu.split(" ")[0]}`;
  const norm = (s) => (s ?? "").replace(/\(.*?\)/g, "").replace(/아파트|APT|\s|[·,.\-]/gi, "");
  const c = norm(core);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const j = await (await fetch(u, { headers: { Referer: `https://${VWORLD_DOMAIN}/`, "User-Agent": UA } })).json();
      const items = (j.response?.result?.items ?? []).filter((it) => {
        const addr = it.address?.parcel ?? it.address?.road ?? "";
        if (!addr.startsWith(head)) return false;
        const t = norm(it.title);
        return c.length >= 3 && (t.includes(c) || c.includes(t));
      });
      // 제목이 단지명과 같은 것 → 부속시설이 아닌 것 → 나머지
      items.sort((a, b) => score(b) - score(a));
      function score(it) {
        const t = norm(it.title);
        return (t === c ? 4 : 0) + (PLACE_NOISE.test(it.title) ? 0 : 2) + (it.title.includes("/") ? 0 : 1);
      }
      const it = items[0];
      const v = it?.point ? { lng: +(+it.point.x).toFixed(6), lat: +(+it.point.y).toFixed(6) } : null;
      geoCache[ck] = v;
      vworldFails = 0;
      await sleep(70);
      return v;
    } catch (e) {
      if (attempt === 3) {
        console.warn("  장소 검색 오류", query, e.message);
        if (++vworldFails >= 3) vworldDown = true;
      }
      await sleep(2500 * attempt);
    }
  }
  return null;
}

/**
 * 법정동 중심 폴백 — V-World search(type=district, category=L4). 준공 후 지번이 합병되어 지번·단지명 모두 못 찾는
 * 사업장(하안주공본1단지 등)을 법정동 중심에라도 표시한다(패널에 "동 중심" 안내).
 */
async function searchDistrict(fullDong) {
  const ck = `EMD:${fullDong}`;
  if (ck in geoCache) return geoCache[ck];
  if (!VWORLD_KEY || vworldDown) return null;
  const u = new URL("https://api.vworld.kr/req/search");
  u.search = new URLSearchParams({
    service: "search", request: "search", version: "2.0", crs: "EPSG:4326", size: "3", page: "1",
    query: fullDong, type: "district", category: "L4", format: "json", errorformat: "json", key: VWORLD_KEY,
  }).toString();
  try {
    const j = await (await fetch(u, { headers: { Referer: `https://${VWORLD_DOMAIN}/`, "User-Agent": UA } })).json();
    const it = (j.response?.result?.items ?? []).find((x) => x.title === fullDong) ?? j.response?.result?.items?.[0];
    const v = it?.point && it.title.endsWith(fullDong.split(" ").pop()) ? { lng: +(+it.point.x).toFixed(6), lat: +(+it.point.y).toFixed(6) } : null;
    geoCache[ck] = v;
    await sleep(70);
    return v;
  } catch (e) {
    console.warn("  법정동 검색 오류", fullDong, e.message);
    return null;
  }
}

/** 지오코딩 후보 주소("경기도 광명시 철산3동 233", "… 철산동 233")에서 법정동 경로 목록("경기도 광명시 철산3동", "… 철산동")을 만든다 */
export function dongsOf(cands) {
  const out = [];
  for (const c of cands) {
    if (c.type !== "PARCEL") continue;
    const d = c.address.replace(/\s*(산\s*)?\d+(-\d+)?\s*$/, "").trim();
    if (/(동|가|리|읍|면)$/.test(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

/**
 * 사업장 이름 → 장소 검색어 목록. "하안주공3·4단지"→["하안주공3단지","하안주공4단지"], "철산주공10,11단지"→…,
 * "영통 2구역(매탄주공 4,5단지)"→괄호 안 단지명 우선. 단지·아파트·주공 등 건물 이름으로 볼 수 있는 것만 만든다
 * (구역명("중1", "덕천")으로 검색하면 엉뚱한 곳이 잡히므로 제외).
 */
export function placeQueries(gu, name) {
  const out = [];
  const inner = [...(name ?? "").matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
  const outer = (name ?? "").replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
  for (const s of [...inner, outer]) {
    if (!/(주공|단지|아파트|APT|연립|빌라|맨션|주택|타운|빌리지)/i.test(s)) continue;
    const base = s.replace(/\s*(재건축|재개발|정비사업|정비구역|주변|일대|일원)\s*/g, " ").replace(/\s+/g, " ").trim();
    // "3·4단지", "4,5단지", "본1단지" → 단지별로 나눠서
    const m = base.match(/^(.*?)(\d+(?:\s*[·,\/]\s*\d+)+)\s*단지(.*)$/);
    if (m) {
      for (const n of m[2].split(/\s*[·,\/]\s*/)) out.push(`${m[1]}${n}단지${m[3]}`.replace(/\s+/g, " ").trim());
    } else out.push(base);
  }
  // "현대아파트"처럼 브랜드만 있는 이름은 시 안에 여러 곳이라 엉뚱한 단지가 잡힘 → 숫자나 3자 이상 고유 이름이 있어야 검색
  const specific = (q) => {
    const stem = q.replace(/\s*(아파트|APT|단지|연립|빌라|맨션|주택|타운|빌리지)\s*$/i, "");
    return /\d/.test(stem) || stem.replace(/[^가-힣]/g, "").length >= 3;
  };
  const uniq = [...new Set(out.filter((q) => q.replace(/\s/g, "").length >= 3 && specific(q)))];
  return uniq.map((q) => ({ query: `${gu.split(" ")[0]} ${q}`, core: q }));
}

/** "개포동 138", "신길동 1583-1", "OO동 산 12-3" → 지오코딩 후보 주소들 (정확→느슨) */
export function addressCandidates(gu, jibun) {
  const j = (jibun ?? "").replace(/\s+/g, " ").trim();
  const m = j.match(/^(\S+?(?:동|가|읍|면|리))\s*(산)?\s*(\d+)(?:-(\d+))?/);
  if (!m) return [];
  const [, dong, san, bon, bu] = m;
  const base = `서울특별시 ${gu} ${dong} ${san ? "산 " : ""}`;
  const c = [];
  if (bu) c.push(`${base}${bon}-${bu}`);
  c.push(`${base}${bon}`);
  return c;
}

/* ------------------------------------------------------------------ */
/*  4. 사업장 ↔ 구역 결합                                                 */
/* ------------------------------------------------------------------ */
const STRIP =
  /주택재건축정비사업조합|재건축정비사업조합|재개발정비사업조합|정비사업조합|정비사업|정비구역|재정비촉진구역|촉진구역|재개발사업|재건축사업|주택재건축|주택재개발|도시환경정비|도시정비형|주택정비형|공공재개발|공공재건축|재건축|재개발|추진위원회|조합|아파트|사업|구역|지구|정비|공공|일대|일원|번지|주택|제(?=\d)/g;

/** ①②③… → 1 2 3 (정보몽땅 사업장 이름 "특별계획구역③") */
const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
export function normName(s) {
  return (s ?? "")
    .replace(/[①-⑳]/g, (c) => String(CIRCLED.indexOf(c) + 1))
    .replace(/\([^)]*\)/g, " ")
    .replace(STRIP, "")
    .replace(/[\s·ㆍ,\-_.~'’"“”]/g, "")
    .toLowerCase();
}

/**
 * a 가 b 를 포함하는가 (b 끝이 숫자면 뒤에 숫자가 이어지지 않아야 함: 장위1 ≠ 장위13).
 * 숫자 뒤에 "차"가 붙으면 다른 단지다 — 신반포4차(잠원동 70, 조합설립) ≠ 신반포4지구(준공, normName 은 "신반포4") (2026-09-08)
 */
export function containsToken(a, b) {
  if (b.length < 2 || a.length < b.length) return false;
  let i = a.indexOf(b);
  while (i >= 0) {
    const next = a[i + b.length];
    const prev = a[i - 1];
    const digitTail = /\d/.test(b[b.length - 1]);
    const digitHead = /\d/.test(b[0]);
    if (!(digitTail && next && /[\d차]/.test(next)) && !(digitHead && prev && /\d/.test(prev))) return true;
    i = a.indexOf(b, i + 1);
  }
  return false;
}

export function nameScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // 둘 다 숫자가 있으면 숫자열이 같아야 한다 — "압구정특별계획2" 와 "압구정특별계획5" 는 다른 구역 (2026-09-08 압구정 1·3·4·5구역이 2구역에 묶이던 문제)
  const na = a.match(/\d+/g), nb = b.match(/\d+/g);
  if (na && nb && na.join(",") !== nb.join(",")) return 0;
  if (containsToken(a, b) || containsToken(b, a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) * 0.9 + 0.05;
  // 공통 접두 길이 비율
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k >= 3 ? (k / Math.max(a.length, b.length)) * 0.6 : 0;
}

export function bbox(g) {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  const walk = (c) => {
    if (typeof c[0] === "number") {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    } else for (const x of c) walk(x);
  };
  walk(g.coordinates);
  return [minX, minY, maxX, maxY];
}

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const hit = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}
export function pointInGeom(pt, g) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  for (const poly of polys) {
    if (!pointInRing(pt, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) if (pointInRing(pt, poly[h])) inHole = true;
    if (!inHole) return true;
  }
  return false;
}

export function distKm(a, b) {
  const dx = (a.lng - b.lng) * 88.8, dy = (a.lat - b.lat) * 111;
  return Math.hypot(dx, dy);
}
/** 점에서 폴리곤 경계(바깥 고리)까지 가장 짧은 거리(m) — 위도 보정 평면 근사 */
export function distToGeomM(pt, g) {
  const rings = g.type === "Polygon" ? [g.coordinates[0]] : g.coordinates.map((p) => p[0]);
  const X = (c) => c[0] * 88800, Y = (c) => c[1] * 111000;
  const px = X(pt), py = Y(pt);
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = X(ring[j]), ay = Y(ring[j]), bx = X(ring[i]), by = Y(ring[i]);
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/*  경기·인천 — 사업장 목록(공공데이터포털 CSV) + V-World 지구단위계획 레이어 폴리곤 */
/* ------------------------------------------------------------------ */
export const SIDO_FULL = { 서울: "서울특별시", 경기: "경기도", 인천: "인천광역시" };

/** 법정동 사전(시군구 단위) → 이름으로 5자리 코드 찾기 */
let SGG = null;
function sggCodeOf(sidoFull, name) {
  if (!SGG) {
    const p = path.join(ROOT, "lib", "bjd-sgg.json");
    SGG = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).map((l) => l.split("|")) : [];
  }
  const n = (name ?? "").trim();
  if (!n) return null;
  // 2026-07 인천 행정구역 개편 전 이름 (자료가 옛 이름을 쓰는 경우)
  const ALIAS = { 인천광역시: { 중구: "제물포구", 동구: "제물포구", 서구: "서해구", 남구: "미추홀구" } };
  const alias = ALIAS[sidoFull]?.[n] ?? n;
  const hit =
    SGG.find(([, full]) => full === `${sidoFull} ${alias}`) ??
    SGG.find(([, full]) => full.startsWith(`${sidoFull} ${alias.split(" ")[0]}`) && full.split(" ").length === 2) ??
    SGG.find(([, full]) => full.startsWith(`${sidoFull} ${alias}`));
  return hit ? hit[0].slice(0, 5) : null;
}

/** 간단 CSV 파서 (따옴표·줄바꿈 포함 필드 지원) */
function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function decodeText(buf) {
  let t = buf.toString("utf8");
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  if (/�/.test(t.slice(0, 4000))) t = new TextDecoder("euc-kr").decode(buf);
  return t;
}

/** 공공데이터포털 파일 내려받기: 상세 페이지의 직접 링크 → 없으면 다운로드 API 로 atchFileId 조회 */
async function downloadDataGoKr(pk, cacheName) {
  const cache = path.join(RAW, cacheName);
  const maxAge = 1000 * 60 * 60 * 24 * 7;
  if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < maxAge && !process.env.FORCE) {
    const m = readJson(cache + ".meta.json");
    if (m?.date && pk === "15055212") SOURCE_INFO.incheon = m.date;
    return fs.readFileSync(cache);
  }
  const page = await (await fetch(`https://www.data.go.kr/data/${pk}/fileData.do`, { headers: { "User-Agent": UA } })).text();
  let link = page.match(/fileDownload\.do\?atchFileId=([^"'&]+)&(?:amp;)?fileDetailSn=(\d+)/);
  if (!link) {
    const m = page.match(/fn_fileDataDown\(\s*'(\d+)'\s*,\s*'([^']+)'/);
    if (m) {
      const res = await fetch("https://www.data.go.kr/tcs/dss/selectFileDataDownload.do", {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Referer: `https://www.data.go.kr/data/${pk}/fileData.do`, "X-Requested-With": "XMLHttpRequest" },
        body: new URLSearchParams({ publicDataPk: m[1], publicDataDetailPk: m[2], atchFileId: "", fileDetailSn: "1", publicDataTyCode: "PR0051" }),
      });
      const j = await res.json().catch(() => ({}));
      const af = j.atchFileId ?? j.dataSetFileDetailInfo?.atchFileId;
      const sn = j.fileDetailSn ?? j.dataSetFileDetailInfo?.fileDetailSn ?? 1;
      if (af) link = [null, af, String(sn)];
    }
  }
  if (!link) throw new Error(`공공데이터포털 ${pk}: 다운로드 링크를 찾지 못함`);
  const res = await fetch(`https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=${link[1]}&fileDetailSn=${link[2]}&insertDataPrcus=N`, { headers: { "User-Agent": UA } });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500 || /<html/i.test(buf.subarray(0, 300).toString())) throw new Error(`공공데이터포털 ${pk}: 파일 대신 HTML 응답`);
  // 파일명의 날짜(…_20260630.csv)를 자료 기준일로
  const cd = res.headers.get("content-disposition") ?? "";
  const d = decodeURIComponent(cd).match(/(\d{8})\.csv/)?.[1];
  const date = d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : new Date().toISOString().slice(0, 10);
  if (pk === "15055212") SOURCE_INFO.incheon = date;
  fs.writeFileSync(cache, buf);
  fs.writeFileSync(cache + ".meta.json", JSON.stringify({ date, downloadedAt: new Date().toISOString() }));
  return buf;
}

/** 헤더에서 열 찾기 */
function col(header, ...keys) {
  const h = header.map((s) => s.replace(/\s+/g, ""));
  for (const k of keys) {
    const i = h.findIndex((s) => s.includes(k));
    if (i >= 0) return i;
  }
  return -1;
}

/** 2026-07 행정구역 개편으로 이름이 바뀐 시군구 — 지오코더는 새 이름만 안다 */
export const SGG_RENAMED = { 인천광역시: { 중구: ["제물포구", "영종구"], 동구: ["제물포구"], 서구: ["서해구", "검단구"], 남구: ["미추홀구"] } };

/** 법정동 사전에서 "경기도 고양시 ? 성사동" 처럼 구가 빠진 주소의 정식 경로(시군구 포함)를 찾는다 */
let EMD_ALL = null;
function emdFullPath(sidoFull, sgg, dong) {
  if (!EMD_ALL) {
    const p = path.join(ROOT, "lib", "bjd-emd.json");
    EMD_ALL = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).map((l) => l.split("|")[1]) : [];
  }
  const head = `${sidoFull} ${sgg.split(" ")[0]}`;
  const hit = EMD_ALL.find((full) => full.startsWith(head) && full.endsWith(` ${dong}`));
  return hit ?? null;
}

/**
 * 자유 형식 위치("경동 40번지 및 율목동 10번지 일원", "경기도 고양시 탄현동 28번지 일원", "제물량로 341 일원")
 * → 지오코딩 후보 [{address, type}] (정식 법정동 경로 → 새 시군구 이름 → 옛 이름 순)
 */
export function locCandidates(sidoFull, sgg, loc) {
  const raw = (loc ?? "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!raw || /^nan$/i.test(raw)) return [];
  const s = raw.replace(/^(서울특별시|경기도|인천광역시)\s+/, "").replace(/^\s*\S+(시|구|군)\s+/, "").replace(/^\s*\S+구\s+/, "");
  const sggs = [...(SGG_RENAMED[sidoFull]?.[sgg] ?? []), sgg];
  const out = [];
  const push = (address, type = "PARCEL") => {
    if (!out.some((x) => x.address === address && x.type === type)) out.push({ address, type });
  };
  for (const m of s.matchAll(/([가-힣]+?)(\d*)(동|가|리|읍|면)\s*(산)?\s*(\d+)(?:-(\d+))?/g)) {
    const [, stem, num, suffix, san, bon, bu] = m;
    // 행정동(송림6동·주안2동)은 법정동(송림동·주안동)으로도 시도
    const dongs = num ? [`${stem}${num}${suffix}`, `${stem}${suffix}`] : [`${stem}${suffix}`];
    for (const dong of dongs) {
      const full = emdFullPath(sidoFull, sgg, dong);
      const bases = [];
      if (full) bases.push(full);
      for (const g of sggs) bases.push(`${sidoFull} ${g} ${dong}`);
      for (const b of bases) {
        const base = `${b} ${san ? "산 " : ""}`;
        if (bu) push(`${base}${bon}-${bu}`);
        push(`${base}${bon}`);
      }
    }
    if (out.length >= 12) break;
  }
  // 도로명("제물량로 341", "송미로23번길 12")
  for (const m of s.matchAll(/([가-힣A-Za-z0-9·]+(?:로|길))\s*(\d+)(?:-(\d+))?/g)) {
    for (const g of sggs) push(`${sidoFull} ${g} ${m[1]} ${m[2]}${m[3] ? `-${m[3]}` : ""}`, "ROAD");
  }
  return out;
}

/** 인천 — 도시 및 주거환경 정비사업 추진현황 (공공데이터포털 15055212, 월간) */
async function fetchIncheon() {
  console.log("· 인천 정비사업 추진현황 (공공데이터포털)");
  const rows = parseCsv(decodeText(await downloadDataGoKr("15055212", "incheon.csv")));
  SOURCE_INFO.incheon = SOURCE_INFO.incheon || new Date(fs.statSync(path.join(RAW, "incheon.csv")).mtimeMs).toISOString().slice(0, 10);
  if (!fs.existsSync(path.join(RAW, "incheon.csv.meta.json"))) fs.writeFileSync(path.join(RAW, "incheon.csv.meta.json"), JSON.stringify({ date: "2026-06-30" }));
  const h = rows[0];
  const iGu = col(h, "구명", "군구", "구"), iName = col(h, "구역명"), iLoc = col(h, "위치"), iArea = col(h, "면적"), iKind = col(h, "사업유형", "유형"), iStage = col(h, "진행단계", "단계");
  const out = [];
  rows.slice(1).forEach((r, i) => {
    const name = (r[iName] ?? "").trim();
    if (!name) return;
    const gu = (r[iGu] ?? "").trim();
    out.push({
      no: 28000000 + i + 1, sido: "인천", gu, guCode: sggCodeOf("인천광역시", gu), source: "인천시",
      kind: (r[iKind] ?? "").trim(), name, loc: (r[iLoc] ?? "").trim(), jibun: "",
      area: Number(String(r[iArea] ?? "").replace(/[^\d.]/g, "")) || null, stage: (r[iStage] ?? "").trim(), docs: "", cafe: null, map: null,
    });
  });
  console.log(`  ${out.length}건`);
  return out;
}

/**
 * 1기 신도시(분당·일산·평촌·산본·중동) 노후계획도시 정비 선도지구 — data/newtown1.json (국토부 선정 발표·각 시 지정 고시 정리).
 * 경기데이터드림 목록에 없어 별도 출처로 넣는다(2026-09-08). 좌표·경계는 구성 단지(complexes)를 V-World 장소 검색 → 필지로 만든다.
 */
function fetchNewtown() {
  const file = path.join(ROOT, "data", "newtown1.json");
  if (!fs.existsSync(file)) return [];
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  SOURCE_INFO.newtown = j.updated ?? "";
  const out = j.items.map((it, i) => {
    const extra = [["신도시", `${it.newtown}${it.zoneNo ? ` · ${it.zoneNo}` : ""}`], ["구성 단지", it.complexes.map((c) => c.split("|")[0]).join(" · ")]];
    if (it.selected) extra.push(["선도지구 선정", it.selected]);
    if (it.designated) extra.push(["특별정비구역 지정", it.designated]);
    if (it.planned) extra.push(["계획 세대수", `${it.planned.toLocaleString()}세대`]);
    const note = it.designated
      ? { date: it.designated, kw: "특별정비구역 지정", src: "국토부·시 발표" }
      : it.note
        ? { ...it.note, src: "국토부·시 발표" }
        : it.selected
          ? { date: it.selected, kw: "선도지구 선정", src: "국토부·시 발표" }
          : null;
    return {
      no: 41900000 + i + 1, sido: "경기", gu: it.gu, guCode: sggCodeOf("경기도", it.gu), source: "1기신도시",
      kind: "재건축(노후계획도시)", name: it.name, loc: it.loc ?? "", jibun: "", area: null, extra,
      stage: it.stage, docs: `${it.units.toLocaleString()}세대${it.planned ? ` (계획 ${it.planned.toLocaleString()})` : ""}`, cafe: null, map: null,
      complexes: it.complexes.map((c) => ({ q: `${it.gu} ${c}`, core: c })), dong: it.dong, note,
    };
  });
  console.log(`· 1기 신도시 선도지구 ${out.length}건 (data/newtown1.json, ${SOURCE_INFO.newtown})`);
  return out;
}

/* ------------------------------------------------------------------ */
/*  구청 정비사업 포털 — 정보몽땅·서울플랜+ 에 없는 초기 단계(안전진단·기본계획) 사업장 보충      */
/* ------------------------------------------------------------------ */
/**
 * 왜 필요한가(2026-09-08, "잠원한신 안전진단 폴리곤이 없다"): 재건축 안전진단은 추진위·조합이 생기기 전 단계라
 *  ① 정보몽땅은 추진주체가 등록한 사업장만 있고(안전진단 기록 42건은 준비위가 자발 등록한 것),
 *  ② 서울플랜+ 도시계획사업 현황의 재건축 추진단계는 PP0201 입안제안부터라 안전진단 코드가 없고,
 *  ③ 의제처리구역 SHP 는 정비구역 지정 이후라서, 안전진단 통과 단지는 어느 출처에도 없다.
 *  서울시 단위 안전진단 현황 공개자료도 없어(열린데이터광장·공공데이터포털 검색 결과 없음) 자치구 포털을 어댑터로 읽는다.
 *  - 서초구 「공동주택 & 재건축 정보포털」 housing.seocho.go.kr 사업현황 목록(POST pageIndex): 사업구분(재건축·리모델링·가로주택·소규모·시장)·
 *    권역·사업명(data-board_seq=rebuild_id)·사업위치·진행상태(기본계획수립·안전진단·정비구역지정·…·구역해제).
 *    상세(POST rebuild_id) 에 사업주체·구역면적·기존/계획 동·세대·층수·용적률·추진현황(날짜 목록).
 *  - 강남구는 게시판 첨부(현황판 파일)만이라 미지원. 다른 구 포털이 확인되면 어댑터를 추가한다.
 *  규칙: 준공·이전고시·해제 등 끝난 기록은 넣지 않고, 같은 구의 정보몽땅 사업장과 이름이 같으면(정규화 이름 일치 또는 유사도 ≥0.7, 숫자 일치, 유형 호환) 건너뛴다.
 *  좌표가 나온 뒤에는 dedupeGuPortal 이 100 m 안의 같은 유형 기록·서울플랜+ 도형 안에 든 것을 다시 걸러낸다(서울플랜+ 기록 번호를 안정되게 유지).
 *  경계는 addParcelZones 의 대표지번 필지(재건축·리모델링). 캐시 data/raw/portal-seocho.json(목록 6일, 상세는 rebuild_id 별 영구),
 *  목록을 못 받으면 캐시 → 이전 projects.json 의 지자체포털 기록 유지(해외 러너 대비).
 */
export const PORTAL_SOURCE = "지자체포털";
const PORTAL_DONE = /준공|이전고시|해제|해산|청산|취소|중단/;
const PORTAL_HEADERS = { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Accept-Language": "ko" };
const MOA_KIND = "모아타운(소규모주택정비 관리지역)";
const portalCachePath = (id) => path.join(RAW, `portal-${id}.json`);

/** 지자체포털 기록의 고정 번호: `어댑터|행 키` 해시 → 13xxxxxx */
function portalNo(key, used) {
  let h = 2166136261;
  for (const ch of key) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let no = 13000000 + (h % 900000);
  while (used.has(no)) no++;
  used.add(no);
  return no;
}
const stripTags = (s) =>
  String(s ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&middot;|&#8231;|‧|ㆍ/g, "·").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const numOf = (s) => {
  const m = String(s ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return m ? +m[0] : null;
};
const unitsOf = (s) => String(s ?? "").match(/(\d[\d,]*)\s*세대/)?.[1]?.replace(/,/g, "");
/** "2025. 5. 28." / "2011.10.31" / "2025.05.30. (부분준공)" → 2025-05-28 */
const dateOf = (s) => {
  const m = String(s ?? "").match(/(\d{4})\s*[.년]\s*(\d{1,2})\s*[.월]?\s*(\d{1,2})?/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${(m[3] ?? "1").padStart(2, "0")}` : "";
};
/** 상세의 추진현황("○ 2025.07.25. 재건축 안전진단 ○ 2025.12.19. 신속통합기획 사전자문 신청") → 날짜순 [{date, text}] */
export function portalHistory(text) {
  const out = [];
  for (const piece of String(text ?? "").split(/[○●▶■◦•]|\n/)) {
    const m = piece.trim().match(/^(\d{4})\s*[.년]\s*(\d{1,2})\s*[.월]?\s*(\d{1,2})?\s*[.일]?\s*(.*)$/);
    if (!m) continue;
    const date = `${m[1]}-${m[2].padStart(2, "0")}-${(m[3] ?? "1").padStart(2, "0")}`;
    const t = m[4].replace(/^[.\s:~\-–]+/, "").trim();
    if (t) out.push({ date, text: t });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
/** 라벨용 짧은 동향 키워드 */
function portalKw(text) {
  return text.replace(/^재건축\s*/, "").replace(/신속통합기획/g, "신통").replace(/정비사업/g, "").replace(/\s+/g, " ").trim().slice(0, 18);
}

/* ── 어댑터 1: 서초구 「공동주택 & 재건축 정보포털」 (목록 POST currRow=페이지, 상세 POST rebuild_id) ── */
const SEOCHO_PORTAL = {
  site: "서초구 공동주택 & 재건축 정보포털",
  url: "https://housing.seocho.go.kr/cpage/businessStatus/businessStatusList.do",
  detail: "https://housing.seocho.go.kr/cpage/businessStatus/businessStatusDetail.do",
  kind: { "재건축 정비사업": "재건축", 리모델링사업: "리모델링", 가로주택정비사업: "가로주택정비", "소규모 재건축 사업": "소규모재건축", "시장 재건축 사업": "시장정비" },
};
async function fetchSeochoPortalList() {
  const rows = [];
  const seen = new Set();
  // 페이지 매김은 currRow 만 듣고(pageIndex 는 무시) 이름과 달리 페이지 번호다(currRow=11 → 11페이지 = 번호 20~11). 10건씩, 빈 페이지에서 멈춘다
  for (let page = 1; page <= 40; page++) {
    const body = new URLSearchParams({ scType1: "", scType2: "", scType3: "", srch_input: "", currRow: String(page) }).toString();
    const html = await (await fetch(SEOCHO_PORTAL.url, { method: "POST", headers: PORTAL_HEADERS, body })).text();
    let added = 0;
    for (const m of html.matchAll(/<tr[^>]*>\s*<td[^>]*>\s*\d+\s*<\/td>([\s\S]*?)<\/tr>/g)) {
      const id = m[1].match(/data-board_seq="(\d+)"/)?.[1];
      if (!id || seen.has(id)) continue;
      const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => stripTags(x[1])); // [사업구분, 권역, 사업명, 사업위치, 진행상태]
      if (tds.length < 5) continue;
      seen.add(id);
      rows.push({ id, kindRaw: tds[0], region: tds[1], name: tds[2], jibun: tds[3], stage: tds[4] });
      added++;
    }
    if (!added) break;
    await sleep(300);
  }
  return rows;
}
async function fetchSeochoPortalDetail(id) {
  const body = new URLSearchParams({ rebuild_id: id, rownum: "1" }).toString();
  const html = await (await fetch(SEOCHO_PORTAL.detail, { method: "POST", headers: PORTAL_HEADERS, body })).text();
  const kv = {};
  for (const m of html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
    const k = stripTags(m[1]);
    const v = stripTags(m[2]);
    if (k && !(k in kv) && !/<select/i.test(m[2])) kv[k] = v;
  }
  return kv;
}
const seochoAdapter = {
  id: "seocho", sido: "서울", gu: "서초구", site: SEOCHO_PORTAL.site, url: SEOCHO_PORTAL.url,
  list: fetchSeochoPortalList,
  // '기타' 는 모아타운·역세권 청년주택·민간임대 등이 섞여 있다 → 모아타운만 받고, 청년주택·임대주택은 정비사업이 아니라 뺀다(서울플랜+ 안심주택 유형을 뺀 것과 같은 기준)
  kindOf: (r) => SEOCHO_PORTAL.kind[r.kindRaw] ?? (/모아타운/.test(r.name) ? MOA_KIND : null),
  enrich: (r) => fetchSeochoPortalDetail(r.id),
  build(r, d, kind) {
    d ??= {};
    const hist = portalHistory(d["추진현황"]);
    const latest = hist[hist.length - 1];
    const extra = [];
    if (d["사업주체"]) extra.push(["사업주체", d["사업주체"]]);
    if (d["지역지구"]) extra.push(["용도지역", d["지역지구"]]);
    if (d["기존현황"]) extra.push(["기존 현황", d["기존현황"]]);
    const planParts = [d["동 및 세대"], d["층수(지상)"] ? `지상 ${d["층수(지상)"]}${d["층수(지하)"] ? ` / 지하 ${d["층수(지하)"]}` : ""}` : "", d["용적율"] ? `용적률 ${d["용적율"]}` : ""].filter(Boolean);
    if (planParts.length) extra.push(["계획", planParts.join(" · ")]);
    if (d["시공사"]) extra.push(["시공사", d["시공사"]]);
    if (hist.length) extra.push(["추진현황", hist.map((h) => `${h.date} ${h.text}`).join(" · ")]);
    if (d["향후계획"]) extra.push(["향후 계획", d["향후계획"]]);
    extra.push(["출처", `${SEOCHO_PORTAL.site} 사업현황 · ${r.region} · 진행상태 '${r.stage}'`]);
    const ex = unitsOf(d["기존현황"]), pl = unitsOf(d["동 및 세대"]);
    // 사업위치는 "잠원동 56-3" 이 보통이지만 "서울특별시 서초구 잠원동 51"·"모아타운A : 양재동 374번지 일원 / …" 도 있다 → 동부터 시작하게 다듬는다
    const jibun = r.jibun.replace(/^.*?:\s*/, "").replace(/^서울(특별)?시\s*/, "").replace(/^서초구\s*/, "").replace(/\s*\/.*$/, "").trim();
    return {
      kind, name: r.name.replace(/\(아\)/g, "아파트"), jibun, loc: `서울특별시 서초구 ${jibun}`, stage: r.stage,
      area: numOf(d["구역면적"]) || null,
      docs: ex ? `${(+ex).toLocaleString()}세대${pl ? ` (계획 ${(+pl).toLocaleString()})` : ""}` : "",
      extra, hist,
      note: latest ? { date: latest.date, kw: portalKw(latest.text), title: `${SEOCHO_PORTAL.site} 추진현황`, url: SEOCHO_PORTAL.url, src: PORTAL_SOURCE } : null,
      portal: { gu: "서초구", site: SEOCHO_PORTAL.site, url: SEOCHO_PORTAL.url, id: r.id },
    };
  },
};

/* ── 어댑터 2: 광명시청 「재건축정비사업 추진현황」 (한 페이지, 구역명이 열·항목이 행인 표 3개) ──
 *  경기데이터드림 시트가 광명 하안주공 6·7·9·10·11·12단지(2025-12-10 정비구역 지정)·1·2단지(추진위 2025-11-20)를 아직 안 실어
 *  아실에는 있는 폴리곤이 우리 지도에 없던 문제(2026-09-08 사용자 스크린샷). 행: 위치·구역면적·추진방식·사업시행자·기존/계획 용적률·동수·세대수·시공사·
 *  추진현황(정비구역 지정·고시, 사업시행자 지정·고시, 추진위 승인, 조합설립인가, 사업시행인가, 관리처분인가, 철거·이주, 착공, 준공, 이전고시). 값 "-" 는 없음. */
const GM_PORTAL = { site: "광명시청 재건축정비사업 추진현황", url: "https://www.gm.go.kr/pt/partInfo/ud/newtown/gm_rebuild.jsp" };
const GM_STEPS = [
  ["정비구역지정", /^정비구역/], ["정비구역지정(신탁 시행자 지정)", /^사업시행자/], ["추진위원회승인", /^추진위/], ["조합설립인가", /^조합설립/],
  ["사업시행인가", /^사업시행인가|^정비사업계획인가|^사업시행계획/], ["관리처분인가", /^관리처분/], ["철거", /철거|이주/], ["착공", /^착공/], ["준공", /^준공/], ["이전고시", /^이전고시/],
];
async function fetchGwangmyeongPortalList() {
  const html = await (await fetch(GM_PORTAL.url, { headers: { "User-Agent": UA, "Accept-Language": "ko" } })).text();
  const rows = [];
  for (const tb of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const trs = [...tb[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/g)].map((c) => stripTags(c[2])));
    if (!trs.length || trs[0][0]?.replace(/\s/g, "") !== "구역명") continue;
    const names = trs[0].slice(1).map((n) => n.replace(/\s+/g, ""));
    const N = names.length;
    const kvs = names.map(() => ({}));
    for (const cells of trs.slice(1)) {
      if (cells.length <= N) continue; // 라벨 없는 줄(조합사무실 주소)
      const labels = cells.slice(0, cells.length - N).map((s) => s.replace(/\([^)]*\)/g, "").replace(/[\s/]/g, ""));
      const key = labels[labels.length - 1]; // rowspan 그룹 라벨(기존현황·계획현황·추진현황) 뒤의 하위 라벨
      cells.slice(-N).forEach((v, i) => {
        const val = v.replace(/^-+$/, "").trim();
        if (key && val && !(key in kvs[i])) kvs[i][key] = val;
      });
    }
    names.forEach((name, i) => {
      const kv = kvs[i];
      const keys = Object.keys(kv);
      const pick = (re) => keys.find((k) => re.test(k));
      const val = (re) => (pick(re) ? kv[pick(re)] : "");
      const loc = val(/^위치/);
      const hist = [];
      for (const [step, re] of GM_STEPS) {
        const raw = val(re);
        const d = dateOf(raw);
        if (d) hist.push({ step, date: d, raw });
      }
      const last = hist[hist.length - 1];
      const planUnitsRaw = val(/^(예정|계획)세대수/);
      rows.push({
        id: name, name, kindRaw: "재건축", jibun: loc.replace(/\s+/g, " ").trim(),
        stage: last ? last.step + (/부분준공/.test(last.raw) ? "(부분)" : "") : "정비예정구역",
        area: numOf(val(/면적/)), method: val(/^추진방식/), agent: val(/^사업시행자$/),
        far: val(/^용적률$/), dongs: val(/^동수$/), units: unitsOf(val(/^세대수$/)) ?? numOf(val(/^세대수$/)),
        planFar: val(/^계획용적률/), planUnits: unitsOf(planUnitsRaw) ?? numOf(planUnitsRaw),
        builder: val(/^시공/), hist,
      });
    });
  }
  return rows;
}
const gwangmyeongAdapter = {
  id: "gwangmyeong", sido: "경기", gu: "광명시", site: GM_PORTAL.site, url: GM_PORTAL.url,
  list: fetchGwangmyeongPortalList,
  kindOf: () => "재건축",
  build(r, _d, kind) {
    const extra = [];
    if (r.method) extra.push(["추진방식", r.method + (r.agent ? ` · ${r.agent}` : "")]);
    const ex = [r.dongs ? `${r.dongs}동` : "", r.units ? `${(+r.units).toLocaleString()}세대` : "", r.far ? `용적률 ${r.far}` : ""].filter(Boolean);
    if (ex.length) extra.push(["기존 현황", ex.join(" · ")]);
    const pl = [r.planUnits ? `${(+r.planUnits).toLocaleString()}세대` : "", r.planFar ? `용적률 ${r.planFar}` : ""].filter(Boolean);
    if (pl.length) extra.push(["계획", pl.join(" · ")]);
    if (r.builder) extra.push(["시공사", r.builder]);
    if (r.hist.length) extra.push(["추진현황", r.hist.map((h) => `${h.date} ${h.step}${/부분준공/.test(h.raw) ? "(부분)" : ""}`).join(" · ")]);
    extra.push(["출처", `${GM_PORTAL.site}(광명재건축 페이지) · ${r.stage}`]);
    const latest = r.hist[r.hist.length - 1];
    return {
      kind, name: r.name, jibun: r.jibun, loc: `경기도 광명시 ${r.jibun}`, stage: r.stage, area: r.area || null,
      docs: r.units ? `${(+r.units).toLocaleString()}세대${r.planUnits ? ` (계획 ${(+r.planUnits).toLocaleString()})` : ""}` : "",
      extra, hist: r.hist.map((h) => ({ date: h.date, text: h.step })),
      note: latest ? { date: latest.date, kw: latest.step.replace(/\(.*\)$/, ""), title: GM_PORTAL.site, url: GM_PORTAL.url, src: PORTAL_SOURCE } : null,
      portal: { gu: "광명시", site: GM_PORTAL.site, url: GM_PORTAL.url, id: r.id },
    };
  },
};
/* ── 어댑터 3: 경기도 정비사업 온누리시스템 「조합 정보공개 홈페이지」 목록 (경기 전역, 추진주체가 홈페이지를 연 사업장 286건, 2026-09-09) ──
 *  index.do 세션 쿠키 + 페이지 안 X-CSRF-TOKEN → POST /onnuri/mbiz/boss/info/biz/ajaxGetBizaraList.do (sigunSeCd=&emdCd=) → message[]:
 *  bizaraId(GHMT_…), bizaraNm, rprsvLotno("경기도 시흥시 신현동(포동) 2번지 일원"), bizTypeNm(재개발·재건축), bizaraStepNm(추진주체 구성 전·추진위원회·조합(시행자)·청산위원회),
 *  bizaraPrgrsStepNm(정비예정구역지정·재건축진단·정비구역지정 전/후·조합설립인가·…·이전고시), sigunSeNm("안양시 만안구"), zoneArea, enfcMthdNm, landOwnerCnt, mdfcnDt.
 *  경기데이터드림 시트가 늦거나 안 싣는 초기 단계(정비예정구역·재건축진단·정비구역지정 전 추진위)를 보충한다. 사업 홈페이지 main.do 의 '주요 추진경과'
 *  (li "정비예정구역지정 [기본계획수립(변경)고시] 2024.03.18 …")를 상세로 읽어 동향·이력으로 쓴다. 폴리곤은 재건축만 필지 폴백(경기 재개발 경계 자료 없음). */
const ONNURI = {
  site: "경기도 정비사업 온누리시스템", index: "https://www.gg.go.kr/onnuri/index.do",
  list: "https://www.gg.go.kr/onnuri/mbiz/boss/info/biz/ajaxGetBizaraList.do", home: (id) => `https://www.gg.go.kr/onnuri/mbiz/home/${id}/main.do`,
};
function onnuriStage(body, prgrs) {
  body = body ?? "";
  prgrs = prgrs ?? "";
  if (/청산/.test(body)) return prgrs || "조합청산";
  if (/추진위/.test(body)) return /지정 전/.test(prgrs) ? "추진위원회(정비구역지정 전)" : "추진위원회승인";
  if (/구성 전/.test(body)) return /재건축진단/.test(prgrs) ? "안전진단(재건축진단)" : /예정/.test(prgrs) ? "정비예정구역" : prgrs || "추진주체 구성 전";
  return prgrs || body;
}
async function fetchOnnuriList() {
  const r = await fetch(ONNURI.index, { headers: { "User-Agent": UA, "Accept-Language": "ko" } });
  const html = await r.text();
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const token = html.match(/X-CSRF-TOKEN",\s*"([^"]+)"/)?.[1];
  if (!token) throw new Error("CSRF 토큰 없음");
  const r2 = await fetch(ONNURI.list, {
    method: "POST", headers: { ...PORTAL_HEADERS, "X-CSRF-TOKEN": token, "X-Requested-With": "XMLHttpRequest", Cookie: cookie, Referer: ONNURI.index }, body: "sigunSeCd=&emdCd=",
  });
  const j = JSON.parse(await r2.text());
  if (j.result !== "Y" || !Array.isArray(j.message)) throw new Error("응답 형식");
  return j.message
    .map((x) => ({
      id: x.bizaraId, name: (x.bizaraNm ?? "").trim(), kindRaw: x.bizTypeNm ?? "", sigun: (x.sigunSeNm ?? "").trim(),
      // "경기도 안양시 만안구 안양9동(안양동) 737번지 일원" → 법정동으로 "안양동 737번지 일원"
      jibun: (x.rprsvLotno ?? "").replace(/^경기도\s+/, "").replace(/^\S+시\s+/, "").replace(/^\S+구\s+/, "").replace(/^\S+\(([^)]+)\)\s*/, "$1 ").trim(),
      body: x.bizaraStepNm ?? "", prgrs: x.bizaraPrgrsStepNm ?? "", stage: onnuriStage(x.bizaraStepNm, x.bizaraPrgrsStepNm),
      area: numOf(x.zoneArea), method: x.enfcMthdNm ?? "", owners: numOf(x.landOwnerCnt), updated: (x.mdfcnDt ?? "").slice(0, 10), infoCnt: numOf(x.infoRlsCnt),
    }))
    .filter((x) => x.id && x.name && x.sigun);
}
async function fetchOnnuriHistory(id) {
  const html = await (await fetch(ONNURI.home(id), { headers: { "User-Agent": UA, "Accept-Language": "ko" } })).text();
  const out = [];
  for (const m of html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
    const h = stripTags(m[1]).match(/^([가-힣·\s]{2,20}?)\s*\[([^\]]*)\]\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(.*)$/);
    if (h) out.push({ step: h[1].trim(), sub: h[2].trim(), date: `${h[3]}-${h[4].padStart(2, "0")}-${h[5].padStart(2, "0")}`, text: h[6].trim() });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
const onnuriAdapter = {
  id: "onnuri", sido: "경기", site: ONNURI.site, url: ONNURI.index,
  guOf: (r) => r.sigun.split(" ")[0], // "안양시 만안구" → 시트·앱의 시군 이름 "안양시"
  list: fetchOnnuriList,
  kindOf: (r) => (/재건축/.test(r.kindRaw) ? "재건축" : /재개발/.test(r.kindRaw) ? "재개발" : null),
  enrich: (r) => fetchOnnuriHistory(r.id),
  build(r, hist, kind) {
    hist = Array.isArray(hist) ? hist : [];
    const latest = hist[hist.length - 1];
    const url = ONNURI.home(r.id);
    const extra = [["추진주체", `${r.body}${r.prgrs ? ` · ${r.prgrs}` : ""}`]];
    if (r.method) extra.push(["시행방식", r.method]);
    if (r.owners) extra.push(["토지등소유자", `${r.owners.toLocaleString()}명`]);
    if (hist.length) extra.push(["추진경과", hist.map((h) => `${h.date} ${h.step}${h.sub ? `(${h.sub})` : ""}`).join(" · ")]);
    extra.push(["출처", `${ONNURI.site} 조합 정보공개 홈페이지 · ${r.sigun}${r.infoCnt ? ` · 정보공개 ${r.infoCnt}건` : ""}${r.updated ? ` · 갱신 ${r.updated}` : ""}`]);
    return {
      kind, name: r.name, jibun: r.jibun, loc: `경기도 ${r.sigun} ${r.jibun}`, stage: r.stage, area: r.area || null, docs: "", extra, hist,
      note: latest ? { date: latest.date, kw: latest.step, title: `${ONNURI.site} 추진경과`, url, src: PORTAL_SOURCE } : null,
      portal: { gu: r.sigun, site: ONNURI.site, url, id: r.id },
    };
  },
};
const PORTAL_ADAPTERS = [seochoAdapter, gwangmyeongAdapter, onnuriAdapter];

/** 이름 비교 키: 정규화 이름에서 구분 기호까지 뺀 것 ("철산주공10,11단지" = "철산주공10·11단지") */
const portalNameKey = (s) => normName(s).replace(/[·,/\s]/g, "");

/**
 * 지자체 포털 사업장 → 사업장 목록 행 (정보몽땅·경기 시트 행과 같은 모양 + extra·note·portal).
 * @param existing 정보몽땅·경기·인천 목록(이름 중복 제거·기존 기록 동향 보강용)  @param prevProjects 이전 projects.json(실패 시 유지)
 */
export async function fetchGuPortals(existing, prevProjects) {
  const prevKeep = (Array.isArray(prevProjects) ? prevProjects : []).filter((p) => p.source === PORTAL_SOURCE);
  const used = new Set(existing.map((p) => p.no));
  const out = [];
  // 앞 어댑터가 만든 기록도 뒤 어댑터의 이름 비교 대상에 넣는다(광명시청 하안주공 ↔ 온누리 하안주공)
  const pool = [...existing];
  let newest = "";
  for (const A of PORTAL_ADAPTERS) {
    const outStart = out.length;
    const cachePath = portalCachePath(A.id);
    let cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : { fetchedAt: "", list: [], details: {} };
    cache.details ??= {};
    let list = cache.list ?? [];
    const fresh = cache.fetchedAt && Date.now() - Date.parse(cache.fetchedAt) < 6 * 864e5;
    console.log(`· 지자체 정비사업 포털 (${A.site})${fresh ? ` — 캐시 ${cache.fetchedAt.slice(0, 10)}` : ""}`);
    if (!fresh) {
      try {
        const rows = await A.list();
        if (!rows.length) throw new Error("0건");
        // 페이지 매김이 깨져 첫 페이지만 온 경우 방지: 지난 목록의 절반도 안 되면 실패로 본다
        if (list.length && rows.length < list.length / 2) throw new Error(`${rows.length}건 (지난 목록 ${list.length}건)`);
        list = rows;
        cache = { ...cache, fetchedAt: new Date().toISOString(), list };
        fs.writeFileSync(cachePath, JSON.stringify(cache));
      } catch (e) {
        const keep = prevKeep.filter((p) => p.portal?.site === A.site);
        console.warn(`  ! 목록 실패(${String(e.message).slice(0, 60)}) → ${list.length ? `캐시 ${list.length}건 사용` : `이전 자료 ${keep.length}건 유지`}`);
        if (!list.length) {
          out.push(...keep);
          continue;
        }
      }
    }
    if (cache.fetchedAt > newest) newest = cache.fetchedAt;
    // 어댑터가 한 시군구(서초구·광명시)이거나 행마다 시군이 다르다(온누리) → 시군 이름별로 원자료 행을 모아 이름 비교
    const exBySido = pool.filter((p) => (p.sido ?? "서울") === A.sido).map((p) => ({ p, n: portalNameKey(p.name), kc: kindClass(p.kind) }));
    const exByGu = new Map();
    const exRowsOf = (gu) => exByGu.get(gu) ?? exByGu.set(gu, exBySido.filter((x) => x.p.gu === gu)).get(gu);
    // 같은 사업으로 보는 이름: 키 일치, 유사도 ≥0.7, 또는 한쪽이 다른 쪽에 통째로 들어 있고 짧은 쪽에 숫자가 있음("113-6" ⊂ "권선113-6구역"; "수택" ⊂ "수택E" 는 제외)
    const sameName = (a, b) => a === b || nameScore(a, b) >= 0.7 || ((containsToken(a, b) || containsToken(b, a)) && /\d/.test(a.length < b.length ? a : b));
    let done = 0, dup = 0, outOfScope = 0, noLoc = 0, detailFail = 0, enriched = 0, added = 0;
    for (const r of list) {
      if (PORTAL_DONE.test(r.stage)) {
        done++;
        continue;
      }
      const kind = A.kindOf(r);
      if (!kind) {
        outOfScope++;
        continue;
      }
      const gu = A.guOf ? A.guOf(r) : A.gu;
      const kc = kindClass(kind);
      const n = portalNameKey(r.name);
      if (r.jibun != null && !/(동|리|가|읍|면)\s*(산\s*)?\d/.test(r.jibun)) {
        noLoc++; // 대표지번이 비었거나 이름만 적힌 행(남양주 덕소2·덕소3)은 지도에 놓을 수 없다
        continue;
      }
      const same = exRowsOf(gu).find((x) => n.length >= 2 && !digitsConflict(n, x.n) && sameName(n, x.n) && (kc === x.kc || kc === "any" || x.kc === "any"));
      if (same) {
        dup++;
        // 같은 사업장이 원자료에 이미 있으면 포털의 더 새로운 추진 일자를 최근 동향으로 보강한다(경기 시트가 뒤처지는 경우)
        const hist = r.hist ?? [];
        const latest = hist[hist.length - 1];
        if (latest && (!same.p.note || latest.date > same.p.note.date)) {
          same.p.note = { date: latest.date, kw: (latest.step ?? portalKw(latest.text ?? "")).replace(/\(.*\)$/, ""), title: `${A.site} 추진현황`, url: A.url, src: PORTAL_SOURCE };
          if (Array.isArray(same.p.extra)) same.p.extra.push([`${A.gu} 포털 추진현황`, hist.map((h) => `${h.date} ${h.step ?? h.text}`).join(" · ")]);
          enriched++;
        }
        continue;
      }
      let d = null;
      if (A.enrich) {
        if (!(r.id in cache.details)) {
          try {
            cache.details[r.id] = await A.enrich(r);
            fs.writeFileSync(cachePath, JSON.stringify(cache));
            await sleep(250);
          } catch {
            detailFail++;
            cache.details[r.id] = null;
          }
        }
        d = cache.details[r.id];
      }
      const b = A.build(r, d, kind);
      out.push({ no: portalNo(`${A.id}|${r.id}`, used), sido: A.sido, gu, guCode: A.sido === "서울" ? GU_CODE[gu] : sggCodeOf(SIDO_FULL[A.sido], gu), source: PORTAL_SOURCE, cafe: null, map: null, ...b });
      added++;
    }
    console.log(`  목록 ${list.length}건 → 끝난 기록 ${done}·범위 밖(청년·임대주택 등) ${outOfScope}·위치 없음 ${noLoc}·원자료와 같은 이름 ${dup}(동향 보강 ${enriched}) 제외 → 후보 ${added}건${detailFail ? ` (상세 실패 ${detailFail})` : ""}`);
    pool.push(...out.slice(outStart));
  }
  SOURCE_INFO.portal = newest.slice(0, 10);
  for (const p of out) console.log(`    ${p.gu} ${p.name} | ${p.jibun} | ${p.kind} · ${p.stage}${p.note ? ` | ${p.note.date} ${p.note.kw}` : ""}`);
  return out;
}

/**
 * 좌표가 나온 뒤의 2차 중복 제거: 지자체포털 후보가 ① 같은 도형에 연결됐거나 100 m 안에 있는 같은 유형의 다른 출처(끝나지 않은) 기록,
 * ② 유형이 맞는 서울플랜+ 도형 안(서울플랜+ 자료가 없으면 이전 서울플랜+ 기록 100 m 안)이면 뺀다 — 서울플랜+ 기록의 번호·출처를 흔들지 않기 위해.
 */
export function dedupeGuPortal(projects, plan, prevProjects, zoneByFid) {
  const portal = projects.filter((p) => p.source === PORTAL_SOURCE);
  if (!portal.length) return;
  const kcOk = (a, b) => {
    const x = kindClass(a), y = kindClass(b);
    return x === y || x === "any" || y === "any";
  };
  const others = projects.filter((p) => p.source !== PORTAL_SOURCE && p.lat != null && !DONE_RAW.test((p.stage ?? "").split(" · ")[0]));
  const infoBySn = new Map((plan?.infos ?? []).map((i) => [i.presentSn, i]));
  // 모아타운(BZ201, cls 비어 있음)은 포털 기록도 모아타운일 때만 같은 사업으로 본다
  const planOk = (T, code, p) => (code === "BZ201" ? /모아타운/.test(p.kind ?? "") : planCompatible(T, p));
  const planFeats = (plan?.features ?? [])
    .filter((f) => SEOULPLAN_TYPES[f.properties.type])
    .map((f) => ({ f, b: bbox(f.geometry), T: SEOULPLAN_TYPES[f.properties.type], n: normName(infoBySn.get(f.properties.presentSn)?.name || f.properties.name) }));
  const prevPlan = plan ? [] : (Array.isArray(prevProjects) ? prevProjects : []).filter((p) => p.source === "서울플랜+" && p.lat != null);
  let dropped = 0;
  for (const p of portal) {
    let why = null;
    const pn = normName(p.name);
    const pt = p.lat != null ? [p.lng, p.lat] : null;
    // ① 같은 도형에 연결됐거나, 다른 기록이 연결된 도형 안에 있거나, 100 m 안 — 유형이 맞는 끝나지 않은 기록
    const near = others.find((q) => {
      if ((q.sido ?? "서울") !== (p.sido ?? "서울")) return false;
      if (p.zoneFid && q.zoneFid === p.zoneFid) return true;
      if (!kcOk(p.kind, q.kind)) return false;
      if (pt && distKm(p, q) <= 0.1) return true;
      const z = q.zoneFid ? zoneByFid?.get(q.zoneFid) : null;
      return !!(pt && z && pointInGeom(pt, z.geometry));
    });
    if (near) why = `${near.source} '${near.name}'`;
    else if ((p.sido ?? "서울") === "서울") {
      // ② 유형이 맞는 서울플랜+ 도형 안에 있거나, 같은 구의 서울플랜+ 사업과 정규화 이름이 같다(applySeoulPlan 이 붙일 것과 같은 조건)
      const hit = planFeats.find(
        ({ f, b, T, n }) =>
          planOk(T, f.properties.type, p) &&
          ((pt && pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3] && pointInGeom(pt, f.geometry)) || (pn.length >= 2 && n === pn && (f.properties.gu === p.guCode || !f.properties.gu))),
      );
      if (hit) why = `서울플랜+ 도형 '${hit.f.properties.name}' (${hit.T.nm})`;
      else {
        const q = prevPlan.find((q) => kcOk(p.kind, q.kind) && ((pt && distKm(p, q) <= 0.1) || (pn.length >= 2 && normName(q.name) === pn && q.gu === p.gu)));
        if (q) why = `이전 서울플랜+ '${q.name}'`;
      }
    }
    if (!why) continue;
    projects.splice(projects.indexOf(p), 1);
    dropped++;
    console.log(`  지자체포털 중복 제외: ${p.name} ↔ ${why}`);
  }
  console.log(`· 지자체포털 보충 사업장 ${portal.length - dropped}건 (좌표 기준 중복 ${dropped} 제외)`);
}

/**
 * 모아타운(소규모주택정비 관리지역) — 서울 도시계획포털 결정고시 목록에서 "소규모주택정비 관리계획(모아타운 관리계획) 승인" 고시를 모아
 * 위치별 항목으로 만들고(관리계획 승인 = 관리지역 지정), data/moatown-sites.json(서울시 대상지 현황 정리)의 아직 승인 전 대상지를 더한다.
 * 경계 벡터는 공개된 것이 없어 마커만 (고시 원문·지형도면은 패널에서 포털 고시로 열림). 2026-09-08 추가.
 */
const GU_BY_CODE = Object.fromEntries(Object.entries(GU).map(([c, n]) => [c, n]));
/** 이름이 완전히 다른 행정동 → 법정동 (관악구 등). 나머지는 숫자·'본' 만 떼면 법정동 */
const ADM_TO_LEGAL = {
  성현동: "봉천동", 청룡동: "봉천동", 은천동: "봉천동", 중앙동: "봉천동", 행운동: "봉천동", 낙성대동: "봉천동", 인헌동: "봉천동",
  서원동: "신림동", 신원동: "신림동", 서림동: "신림동", 미성동: "신림동", 난곡동: "신림동", 난향동: "신림동", 조원동: "신림동", 대학동: "신림동", 신사동_관악: "신림동",
  망우본동: "망우동", 면목본동: "면목동",
};
function dongLegal(d) {
  // 행정동 → 법정동 근사: 자양1동→자양동, 면목본동→면목동, 중화1동→중화동, 신월3동→신월동, 원효로4가는 그대로
  if (ADM_TO_LEGAL[d]) return ADM_TO_LEGAL[d];
  return d.replace(/(본|\d+(?:·\d+)*)동$/, "동");
}
function parseMoaTitle(title) {
  const t = title.replace(/\s+/g, " ").trim();
  // "강북구 수유동1지역 (수유동 52-1번지 일대)" 처럼 괄호 안에 위치가 있으면 그것을
  const inner = t.match(/\(([가-힣0-9\s\-·]+?(?:번지)?\s*일대)\)/)?.[1];
  const head = (inner ?? t).replace(/^서울특별시\s+\S+구\s+/, "");
  const m = head.match(/([가-힣]+\d*(?:동|가))\s*(\d+(?:-\d+)?)/);
  if (!m) return null;
  return { dongAdm: m[1], dong: dongLegal(m[1]), bon: m[2], loc: `${m[1]} ${m[2]}번지 일대`, label: (inner ? t.split("(")[0] : head.split(/소규모주택정비|모아타운/)[0]).trim() };
}
async function fetchMoatown(plan) {
  const cache = path.join(RAW, "moatown-ntfc.json");
  let list = null;
  try {
    const r = await fetch("https://urban.seoul.go.kr/ntfc/getNtfcList.json", {
      method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8", "User-Agent": UA }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ pageNo: 1, pageSize: 300, keywordList: ["모아타운"], srchType: "title" }),
    });
    const j = await r.json();
    list = j.content ?? j.list ?? []; // 응답은 Spring Page(content) 형태
    if (list.length) fs.writeFileSync(cache, JSON.stringify(list));
  } catch (e) {
    console.warn("  도시계획포털 모아타운 고시 목록 실패:", e.message.slice(0, 60));
    list = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, "utf8")) : [];
  }
  // 위치별로 묶기 (관리계획 승인·변경만; 구역 안 가로주택 조합설립인가 등은 사업장이라 제외)
  const byLoc = new Map();
  for (const x of list) {
    const title = (x.title ?? "").replace(/\s+/g, " ").trim();
    if (!/소규모주택정비\s*관리계획/.test(title) || /조합설립|사업시행|관리처분/.test(title)) continue;
    const loc = parseMoaTitle(title);
    if (!loc) continue;
    const date = String(x.noticeDate ?? x.date ?? "").slice(0, 10).replace(/\./g, "-");
    const kind = /변경/.test(title) ? "변경 승인" : /지정을 위하여|열람|공람/.test(title) ? "공람" : "승인";
    const key = `${loc.dong}|${loc.bon.split("-")[0]}`;
    // 자치구는 고시번호 코드 앞 5자리(11590NTC… = 동작구)에서. 11000 은 시 본청 고시 → 아래에서 동 이름으로
    const gu = GU_BY_CODE[String(x.noticeCode ?? "").slice(0, 5)] ?? null;
    const cur = byLoc.get(key) ?? { loc, gu, notices: [] };
    if (!cur.gu && gu) cur.gu = gu;
    cur.notices.push({ date, kind, title, code: x.noticeCode ?? "" });
    byLoc.set(key, cur);
  }
  // 시 본청(11000) 고시는 자치구가 없다 → 법정동 사전에서 동 이름으로
  const emdList = fs.existsSync(path.join(ROOT, "lib", "bjd-emd.json")) ? JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "bjd-emd.json"), "utf8")).map((l) => l.split("|")[1]) : [];
  const guOfDong = (dong) => {
    const hits = emdList.filter((f) => f.startsWith("서울특별시 ") && f.endsWith(` ${dong}`));
    return hits.length === 1 ? hits[0].split(" ")[1] : null;
  };
  const portalUrl = (code) => `https://urban.seoul.go.kr/view/html/PMNU5030110000?noticeCode=${encodeURIComponent(code)}`;
  // 대상지 현황(서울시 PDF + 수동 추가) — 법정동|본번 키
  const sitesPath = path.join(ROOT, "data", "moatown-sites.json");
  const sites = fs.existsSync(sitesPath) ? JSON.parse(fs.readFileSync(sitesPath, "utf8")) : { items: [] };
  const siteByKey = new Map();
  for (const s of sites.items ?? []) if (s.dong && s.bon) siteByKey.set(`${dongLegal(s.dong)}|${String(s.bon).split("-")[0]}`, s);
  // 같은 동에서 본번이 ±30 이면 같은 곳으로 본다 — 대상지 표기 지번과 고시·서울플랜+ 지번이 다를 수 있음
  const nearKey = (map, dong, bon) => [...map.keys()].find((k) => k.startsWith(`${dong}|`) && Math.abs(+k.split("|")[1] - +String(bon).split("-")[0]) <= 30);

  const used = new Set();
  const out = [];
  const zones = [];
  const consumedLoc = new Set(), consumedSite = new Set();

  /* ---- ① 서울플랜+ (도형 + 추진단계) — 있으면 모아타운의 기본 출처 ---- */
  const featBySn = new Map((plan?.features ?? []).map((f) => [f.properties.presentSn, f]));
  const infos = [...(plan?.infos ?? [])].sort((a, b) => a.presentSn.localeCompare(b.presentSn));
  let planN = 0, cancelled = 0;
  for (const info of infos) {
    const a = parseMoaAddr(info.addr) ?? parseMoaAddr(info.name);
    const f = featBySn.get(info.presentSn);
    const key = a ? `${a.dong}|${a.bon.split("-")[0]}` : `sn|${info.presentSn}`;
    const locKey = a ? (byLoc.has(key) ? key : nearKey(byLoc, a.dong, a.bon)) : null;
    const grp = locKey ? byLoc.get(locKey) : null;
    if (locKey) consumedLoc.add(locKey);
    const sKey = a ? (siteByKey.has(key) ? key : nearKey(siteByKey, a.dong, a.bon)) : null;
    const site = sKey ? siteByKey.get(sKey) : null;
    if (sKey) consumedSite.add(sKey);
    const hist = Object.fromEntries(info.history.map((h) => [h.cd, h.date]));
    const isCancel = info.propelCd === "PP0407";
    const approved = grp?.notices.find((n) => n.kind === "승인" || n.kind === "변경 승인");
    const stage = isCancel ? "대상지 취소" : approved || info.propelCd === "PP0406" ? "관리계획 승인(관리지역 지정)" : (MOA_PROPEL[info.propelCd] ?? "대상지 선정");
    const cleanName = info.name.replace(/^\[취소구역\]\s*/, "").replace(/\s*모아타운(\s*관리계획)?$/, "").trim();
    const gu = info.gu || grp?.gu || site?.gu || (a && guOfDong(a.dong));
    if (!gu) continue;
    const last = grp?.notices[grp.notices.length - 1];
    const lastHist = info.history[info.history.length - 1];
    const extra = [
      ["추진단계(서울플랜+)", `${info.propelNm}${hist[info.propelCd] ? ` · ${hist[info.propelCd]}` : ""}`],
      ...(hist.PP0402 || site?.selected ? [["대상지 선정", hist.PP0402 ?? site.selected]] : []),
      ...(hist.PP0406 || approved ? [["관리지역 고시", hist.PP0406 ?? approved.date]] : []),
      ...(info.region ? [["권역", info.region]] : []),
      ...(last ? [["고시", last.title.slice(0, 60)]] : []),
    ];
    const note = last
      ? { date: last.date, kw: `관리계획 ${last.kind}`, title: last.title, url: portalUrl(last.code), src: "도시계획포털" }
      : lastHist?.date
        ? { date: lastHist.date, kw: MOA_PROPEL[lastHist.cd] ?? info.propelNm, title: `서울플랜+ 모아타운 ${info.propelNm}`, url: SEOULPLAN_PAGE, src: "도시계획포털" }
        : null;
    out.push({
      no: moaNo(key, used), sido: "서울", gu, guCode: null, source: "모아타운", kind: "모아타운(소규모주택정비 관리지역)",
      name: `${cleanName} 모아타운${isCancel ? "(취소)" : ""}`, jibun: a ? `${a.dong} ${a.bon}` : "",
      loc: `서울특별시 ${gu} ${info.addr || cleanName}${/일대|일원/.test(info.addr || cleanName) ? "" : " 일대"}`,
      area: info.area ?? (f?.properties.area || null), extra, stage, docs: "", cafe: null, map: null, note,
      presetZone: f ? { fid: info.presentSn, how: "seoulplan" } : undefined,
    });
    if (f) {
      zones.push({
        type: "Feature", geometry: f.geometry,
        properties: {
          fid: info.presentSn, id: info.presentSn, name: cleanName, code: "BZ201", gu: f.properties.gu || info.guCode || "11000",
          area: Math.round(info.area ?? f.properties.area ?? areaM2(f.geometry)), ntfc: "", bbox: bbox(f.geometry), sido: "서울", src: "seoulplan",
        },
      });
    }
    planN++;
    if (isCancel) cancelled++;
  }

  /* ---- ② 도시계획포털 고시에만 있는 곳 (서울플랜+ 미등재·실패 시 전부) ---- */
  let gosiOnly = 0;
  for (const [key, v] of byLoc) {
    if (consumedLoc.has(key)) continue;
    v.notices.sort((a, b) => a.date.localeCompare(b.date));
    const first = v.notices.find((n) => n.kind === "승인") ?? v.notices[0];
    const last = v.notices[v.notices.length - 1];
    const gu = v.gu ?? guOfDong(v.loc.dong);
    if (!gu) continue;
    const stage = last.kind === "공람" && !v.notices.some((n) => n.kind !== "공람") ? "관리계획 공람" : "관리계획 승인(관리지역 지정)";
    out.push({
      no: moaNo(key, used), sido: "서울", gu, guCode: null, source: "모아타운", kind: "모아타운(소규모주택정비 관리지역)",
      name: `${v.loc.label || v.loc.loc} 모아타운`, jibun: `${v.loc.dong} ${v.loc.bon}`, loc: `서울특별시 ${gu} ${v.loc.loc}`, area: null,
      extra: [["관리계획 승인", first.date], ...(last !== first ? [["최근 고시", `${last.kind} ${last.date}`]] : []), ["고시", last.title.slice(0, 60)]],
      stage, docs: "", cafe: null, map: null,
      note: { date: last.date, kw: `관리계획 ${last.kind}`, title: last.title, url: portalUrl(last.code), src: "도시계획포털" },
    });
    gosiOnly++;
  }

  /* ---- ③ 대상지 현황에만 있는 곳 (서울플랜+·고시 미등재 — 동작동 102-8 처럼 최근 선정) ---- */
  let added = 0;
  for (const [key, s] of siteByKey) {
    if (consumedSite.has(key) || byLoc.has(key)) continue;
    const loc = { dong: dongLegal(s.dong), bon: String(s.bon), loc: `${s.dongAdm ?? s.dong} ${s.bon}번지 일대` };
    if (nearKey(byLoc, loc.dong, loc.bon)) continue;
    out.push({
      no: moaNo(key, used), sido: "서울", gu: s.gu, guCode: null, source: "모아타운", kind: "모아타운(소규모주택정비 관리지역)",
      name: `${s.gu} ${loc.loc} 모아타운 대상지`, jibun: `${loc.dong} ${loc.bon}`, loc: `서울특별시 ${s.gu} ${loc.loc}`, area: s.area ?? null,
      extra: [["대상지 선정", s.selected ?? ""], ["출처", sites.source ?? "서울시 모아타운 대상지 현황"]], stage: "대상지 선정", docs: "", cafe: null, map: null,
      note: s.selected ? { date: s.selected, kw: "대상지 선정", src: "국토부·시 발표" } : null,
    });
    added++;
  }
  console.log(`· 모아타운 ${out.length}건 (서울플랜+ ${planN}, 그중 취소 ${cancelled} · 고시만 ${gosiOnly} · 대상지 현황만 ${added}; 도시계획포털 고시 ${list.length}건) · 도형 ${zones.length}개`);
  return { projects: out, zones };
}

/* ------------------------------------------------------------------ */
/*  서울플랜+ (도시계획포털 '도시계획사업 현황') — 도시계획사업 28종 도형·추진단계 (2026-09-08 사용자 요청 ①모아타운 폴리곤 ②다른 유형도)   */
/*  urban.seoul.go.kr 의 사업 현황 지도는 ArcGIS 서버(레이어 UPIS_C_UQ120, ATRB_SE = 사업유형 BZxxx)를 포털 프록시                     */
/*  /proxy/proxy.jsp?<arcgis url> 로 호출한다(키 불필요, Referer 필요, 2,982개 2026-09, maxRecordCount 10000, 페이지 매김 불가).        */
/*  사업 기본정보(추진단계·이력·면적·권역)는 POST bsns/getBsnsListReturnDto.json { presentSnList } (200개씩; 서버가 특정 기록에서       */
/*  EntityNotFound 를 내면 반으로 갈라 재시도). 추진단계 코드는 유형별 PPxx 묶음(아래 PLAN_PROPEL, 사업정보에 이름이 있으면 그것 우선).   */
/*  포함 유형은 SEOULPLAN_TYPES — 정비·소규모·역세권·촉진구역·공공복합·리모델링 등 정비사업 성격만. 미리내집·안심주택(임대 공급),         */
/*  촉진지구·존치(SHP 울타리 도형이 이미 있음), 도시재생, 사전협상은 제외.                                                             */
/*  캐시 data/raw/seoulplan.json(7일, 깃 미추적). 실패하면 캐시 → 그것도 없으면 이전 projects/zones 의 서울플랜+ 기록·도형 유지.       */
/* ------------------------------------------------------------------ */
const SEOULPLAN_CACHE = path.join(RAW, "seoulplan.json");
const SEOULPLAN_QUERY = "https://urban.seoul.go.kr/proxy/proxy.jsp?http://98.33.2.225:6080/arcgis/rest/services/UPIS/20200526_WFS/MapServer/12/query";
const SEOULPLAN_DTO = "https://urban.seoul.go.kr/bsns/getBsnsListReturnDto.json";
export const SEOULPLAN_PAGE = "https://urban.seoul.go.kr/view/html/PMNU1100000001?bsnsCd=BZ201";
export const seoulPlanUrl = (type) => `https://urban.seoul.go.kr/view/html/PMNU1100000001?bsnsCd=${type}`;
/**
 * 포함 사업유형: nm 표시 이름, kind 앱 사업구분, cls 기존 사업장과 같은 사업으로 볼 수 있는 kindClass 값(비어 있으면 항상 새 기록),
 * suffix 새 기록 이름 뒤에 붙일 말(이름에 key 가 없을 때)
 */
export const SEOULPLAN_TYPES = {
  BZ101: { nm: "신속통합기획", kind: "신속통합기획", cls: ["redev", "rebuild", "any"], suffix: "신속통합기획", key: /신속통합|신통/, track: "신통" },
  BZ102: { nm: "재개발(도시정비형)", kind: "재개발(도시정비형)", cls: ["redev", "any"], suffix: "도시정비형 재개발", key: /재개발|정비/ },
  BZ103: { nm: "재개발(주택정비형)", kind: "재개발(주택정비형)", cls: ["redev", "any"], suffix: "재개발", key: /재개발|정비/ },
  BZ104: { nm: "재건축(단독)", kind: "재건축", cls: ["rebuild", "any"], suffix: "재건축", key: /재건축/ },
  BZ105: { nm: "재건축(공동)", kind: "재건축", cls: ["rebuild", "any"], suffix: "재건축", key: /재건축/ },
  BZ107: { nm: "주거환경개선(관리형)", kind: "주거환경개선", cls: ["env", "any"], suffix: "주거환경개선(관리형)", key: /주거환경/ },
  BZ108: { nm: "주거환경개선(정비형)", kind: "주거환경개선", cls: ["env", "any"], suffix: "주거환경개선", key: /주거환경/ },
  BZ201: { nm: "모아타운", kind: "모아타운(소규모주택정비 관리지역)", cls: [], suffix: "모아타운", key: /모아타운/ },
  BZ202: { nm: "가로주택정비사업", kind: "가로주택정비", cls: ["small"], suffix: "가로주택정비", key: /가로주택/ },
  BZ203: { nm: "자율주택정비사업", kind: "자율주택정비", cls: ["small"], suffix: "자율주택정비", key: /자율주택/ },
  BZ204: { nm: "소규모재건축사업", kind: "소규모재건축", cls: ["small"], suffix: "소규모재건축", key: /소규모재건축|재건축/ },
  BZ205: { nm: "소규모재개발사업", kind: "소규모재개발", cls: ["small"], suffix: "소규모재개발", key: /소규모재개발|재개발/ },
  BZ301: { nm: "역세권 장기전세주택", kind: "역세권 장기전세주택(도시정비형 재개발)", cls: ["redev", "any"], suffix: "역세권 장기전세주택", key: /장기전세|역세권/ },
  BZ302: { nm: "역세권 활성화", kind: "역세권 활성화", cls: ["redev", "rebuild", "any"], suffix: "역세권 활성화", key: /역세권/, track: "역세권활성화" },
  BZ402: { nm: "재정비촉진구역", kind: "재정비촉진구역", cls: ["redev", "rebuild", "any"], suffix: "재정비촉진구역", key: /촉진|구역/ },
  BZ501: { nm: "공공주택지구조성사업", kind: "공공주택지구", cls: [], suffix: "공공주택지구", key: /공공주택|지구/ },
  BZ502: { nm: "도심 공공주택 복합사업", kind: "도심공공주택복합", cls: ["redev", "rebuild", "any"], suffix: "도심공공주택복합", key: /공공|복합/, track: "도심복합" },
  BZ601: { nm: "도시개발사업", kind: "도시개발", cls: [], suffix: "도시개발", key: /도시개발/ },
  BZ602: { nm: "공동주택 리모델링", kind: "리모델링", cls: ["remodel"], suffix: "리모델링", key: /리모델링/ },
  BZ603: { nm: "시장정비사업", kind: "시장정비", cls: ["any"], suffix: "시장정비", key: /시장/ },
};
/** 추진단계 코드 → 이름 (서울플랜+ 사전 2026-09-08; 사업정보에 이름이 오면 그것이 우선) */
export const PLAN_PROPEL = {
  PP0101: "대상지선정", PP0103: "기획완료", PP0105: "취소",
  PP0201: "입안제안", PP0202: "열람공고", PP0203: "위원회심의", PP0204: "구역지정", PP0205: "추진위구성", PP0206: "조합설립인가", PP0207: "건축심의", PP0208: "사업시행인가", PP0209: "관리처분계획인가", PP0210: "착공", PP0211: "준공", PP0212: "취소",
  PP0301: "대상지선정", PP0302: "정비계획수립", PP0303: "위원회심의", PP0304: "구역지정", PP0305: "사업시행인가", PP0306: "착공", PP0307: "준공(일부)", PP0308: "준공",
  PP0401: "관리계획 수립범위 자문", PP0402: "대상지 선정", PP0404: "관리계획 사전자문", PP0405: "관리계획 위원회 심의", PP0406: "관리계획 승인(관리지역 지정)", PP0407: "대상지 취소",
  PP0500: "조합설립인가 추진중(연번부여)", PP0501: "조합설립인가", PP0502: "건축심의", PP0503: "사업시행인가", PP0504: "착공", PP0505: "준공", PP0506: "중단",
  PP0601: "주민합의체 구성", PP0602: "건축심의", PP0603: "사업시행인가", PP0604: "착공", PP0605: "준공", PP0606: "중단",
  PP0701: "조합설립추진중", PP0702: "조합설립인가", PP0703: "건축심의", PP0704: "사업시행계획인가", PP0705: "착공", PP0706: "준공", PP0707: "중단",
  PP0801: "대상지선정", PP0802: "사전검토", PP0803: "입안제안", PP0804: "열람공고", PP0805: "위원회심의", PP0806: "구역지정", PP0807: "건축심의", PP0808: "사업계획승인", PP0809: "착공", PP0810: "준공", PP0811: "취소",
  PP1001: "지구지정", PP1002: "지구변경", PP1003: "지구해제",
  PP1101: "대상지선정", PP1102: "촉진계획수립(변경)", PP1103: "열람공고", PP1104: "위원회심의", PP1105: "구역지정", PP1106: "구역취소", PP1107: "추진위구성", PP1108: "조합설립인가", PP1109: "건축심의", PP1110: "사업시행인가", PP1111: "관리처분계획인가", PP1112: "착공", PP1113: "준공",
  PP1201: "예정지구지정", PP1202: "후보지선정", PP1203: "지구지정", PP1204: "설계공모완료", PP1205: "사업계획승인", PP1206: "착공", PP1207: "준공", PP1210: "해제",
  PP1301: "입안제안", PP1302: "열람공고", PP1303: "위원회심의", PP1304: "구역지정", PP1305: "실시계획인가", PP1306: "준공",
  PP1401: "조합설립인가", PP1402: "1차 안전진단", PP1403: "건축심의", PP1404: "리모델링허가승인", PP1405: "2차 안전진단", PP1406: "착공", PP1407: "준공", PP1408: "취소",
  PP1501: "추진계획수립중", PP1502: "추진계획승인", PP1503: "조합설립인가", PP1504: "사업시행계획인가", PP1505: "관리처분계획인가", PP1506: "착공", PP1507: "준공",
  PP1801: "대상지선정", PP1802: "통심위 사전자문", PP1803: "입안제안", PP1804: "열람공고", PP1805: "위원회심의", PP1806: "구역지정", PP1807: "건축심의", PP1808: "사업계획승인", PP1809: "착공", PP1810: "준공", PP1811: "취소",
  PP2001: "입안제안", PP2002: "열람공고", PP2003: "위원회심의", PP2004: "구역지정", PP2005: "지구계획승인(변경)", PP2006: "착공", PP2007: "준공",
  PP2101: "구역지정", PP2102: "구역변경", PP2103: "구역해제",
};
export const MOA_PROPEL = { PP0401: PLAN_PROPEL.PP0401, PP0402: PLAN_PROPEL.PP0402, PP0404: PLAN_PROPEL.PP0404, PP0405: PLAN_PROPEL.PP0405, PP0406: PLAN_PROPEL.PP0406, PP0407: PLAN_PROPEL.PP0407 };
/** 사업이 끝난(취소·해제·중단) 추진단계 */
export const PLAN_ENDED = /취소|해제|중단/;
const round6 = (c) => (typeof c[0] === "number" ? c.map((v) => +v.toFixed(6)) : c.map(round6));
const coordDepth = (c) => (Array.isArray(c) ? 1 + coordDepth(c[0]) : 0);
const okPolygon = (g) => !!g && ((g.type === "Polygon" && coordDepth(g.coordinates) === 3) || (g.type === "MultiPolygon" && coordDepth(g.coordinates) === 4));
const mapPlanDto = (d) => ({
  presentSn: d.presentSn, type: d.classifyL ?? "", typeNm: d.classifyLNm ?? "", name: (d.bsnsName ?? "").trim(), addr: (d.bsnsAddr ?? "").trim(), area: +d.bsnsArea || null,
  gu: d.siteName ?? "", guCode: d.siteCode ?? "", propelCd: d.propelCd ?? "", propelNm: d.propelCdNm ?? "", region: d.rgnCodeNm ?? "",
  history: (Array.isArray(d.tnBsnsPropels) ? d.tnBsnsPropels : [])
    .map((x) => ({ cd: x.propelCd, date: String(x.propelDt ?? "").slice(0, 10) }))
    .filter((x) => x.cd)
    .sort((a, b) => a.date.localeCompare(b.date)),
});
/** 사업정보를 200개씩 받는다. 서버가 특정 기록에서 오류를 내면(추진단계 코드 누락 EntityNotFound) 반으로 갈라 재시도, 1개짜리 실패는 건너뜀 */
async function fetchPlanInfos(sns, headers) {
  const out = [];
  let failed = 0;
  const run = async (chunk) => {
    try {
      const r = await fetch(SEOULPLAN_DTO, { method: "POST", headers: { ...headers, "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify({ presentSnList: chunk }), signal: AbortSignal.timeout(120000) });
      const t = await r.text();
      const j = JSON.parse(t);
      if (!Array.isArray(j)) throw new Error(t.slice(0, 80));
      out.push(...j.map(mapPlanDto));
    } catch {
      if (chunk.length <= 1) {
        failed++;
        return;
      }
      const m = chunk.length >> 1;
      await run(chunk.slice(0, m));
      await run(chunk.slice(m));
    }
  };
  for (let i = 0; i < sns.length; i += 200) {
    await run(sns.slice(i, i + 200));
    await sleep(60);
  }
  if (failed) console.warn(`  서울플랜+ 사업정보 없는 기록 ${failed}건 (서버 오류) → 도형 속성으로만`);
  return out;
}
export async function fetchSeoulPlan() {
  const prev = readJson(SEOULPLAN_CACHE);
  if (prev && Date.now() - new Date(prev.fetchedAt).getTime() < 1000 * 60 * 60 * 24 * 7 && !process.env.FORCE) return prev;
  const headers = { "User-Agent": UA, Referer: SEOULPLAN_PAGE };
  try {
    const u = `${SEOULPLAN_QUERY}?where=1%3D1&outFields=PRESENT_SN,ATRB_SE,DGM_NM,DGM_AR,SIGNGU_SE,PROPEL_CD&returnGeometry=true&outSR=4326&f=geojson`;
    const gj = await (await fetch(u, { headers, signal: AbortSignal.timeout(300000) })).json();
    if (!gj?.features?.length) throw new Error(gj?.error?.message ?? "도형 0개");
    const features = gj.features
      .filter((f) => okPolygon(f.geometry) && f.properties?.PRESENT_SN && f.properties?.ATRB_SE)
      .map((f) => ({
        type: "Feature", geometry: { type: f.geometry.type, coordinates: round6(f.geometry.coordinates) },
        properties: { presentSn: f.properties.PRESENT_SN, type: f.properties.ATRB_SE, name: (f.properties.DGM_NM ?? "").trim(), gu: f.properties.SIGNGU_SE ?? "", area: Math.round(+f.properties.DGM_AR || 0), propelCd: f.properties.PROPEL_CD ?? null },
      }));
    const infos = await fetchPlanInfos(features.map((f) => f.properties.presentSn), headers);
    if (!infos.length) throw new Error("사업정보 0건");
    const out = { fetchedAt: new Date().toISOString().slice(0, 10), source: SEOULPLAN_PAGE, features, infos };
    fs.writeFileSync(SEOULPLAN_CACHE, JSON.stringify(out));
    const byType = {};
    for (const f of features) byType[f.properties.type] = (byType[f.properties.type] ?? 0) + 1;
    console.log(`· 서울플랜+ 도시계획사업 도형 ${features.length}개 · 사업정보 ${infos.length}건 (유형 ${Object.keys(byType).length}종)`);
    return out;
  } catch (e) {
    console.warn("  서울플랜+ 실패:", e.message.slice(0, 80), prev ? `→ 캐시 ${prev.fetchedAt} 사용` : "→ 이전 자료 유지");
    return prev ?? null;
  }
}
/** 특정 사업유형만 뽑은 부분 스냅샷 (fetchMoatown 이 BZ201 만 받는다) */
export function planSubset(plan, types) {
  if (!plan) return null;
  const set = new Set(types);
  return { ...plan, features: plan.features.filter((f) => set.has(f.properties.type)), infos: plan.infos.filter((i) => set.has(i.type)) };
}
/** 서울플랜+ 사업유형이 기존 사업장(kind)과 같은 사업으로 볼 수 있는가 */
export function planCompatible(T, p) {
  if (T.cls.includes("remodel")) return /리모델링/.test(p.kind ?? "");
  const kc = kindClass(p.kind);
  if (kc === "none") return false;
  return T.cls.includes(kc);
}
/** 서울플랜+ 기록의 고정 번호: PRESENT_SN 해시 → 12xxxxxx */
function planNo(sn, used) {
  let h = 2166136261;
  for (const ch of sn) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let no = 12000000 + (h % 900000);
  while (used.has(no)) no++;
  used.add(no);
  return no;
}
/**
 * 서울플랜+ 도시계획사업(모아타운 제외)을 기존 사업장·구역과 합친다.
 *  ① 도형이 기존 구역(SHP·V-World·특별계획 대표 도형)과 같은 곳(bbox 겹침·중심점 상호 포함·IoU ≥ 0.5)이면 그 구역을 쓰고 새 도형은 만들지 않는다
 *  ② 그 구역에 연결된(또는 도형 안에 좌표가 있는) 유형이 맞는 기존 사업장이 있으면 plan{type,stage,date,history,ended} 을 붙이고,
 *     최근 동향(note)이 없거나 오래됐으면 서울플랜+ 단계로 채운다. 사업장에 도형이 없으면 서울플랜+ 도형을 연결(zoneHow seoulplan)
 *  ③ 맞는 사업장이 없으면 source '서울플랜+' 기록을 새로 만든다 (no = PRESENT_SN 해시 12xxxxxx, 단계 = 추진단계 이름, 좌표 = 도형 중심)
 *  plan 이 없으면(포털 실패·캐시 없음) 이전 projects.json 의 서울플랜+ 기록과 plan 필드, 이전 zones 의 seoulplan 도형을 유지한다
 */
export function applySeoulPlan(projects, zones, plan, prevZones, prevProjects, zoneByFid) {
  const prevPlanZones = (prevZones?.features ?? []).filter((f) => f.properties?.src === "seoulplan" && f.properties.code !== "BZ201");
  if (!plan) {
    const prevList = Array.isArray(prevProjects) ? prevProjects : [];
    const prevByNo = new Map(prevList.map((p) => [p.no, p]));
    let kept = 0, planKept = 0;
    for (const z of prevPlanZones) if (!zoneByFid.has(z.properties.fid)) {
      zones.push(z);
      zoneByFid.set(z.properties.fid, z);
    }
    for (const q of prevList) if (q.source === "서울플랜+") {
      projects.push(q);
      kept++;
    }
    for (const p of projects) {
      const q = prevByNo.get(p.no);
      if (q?.plan && !p.plan && p.source !== "서울플랜+") {
        p.plan = q.plan;
        planKept++;
      }
    }
    console.log(`· 서울플랜+ 자료 없음 → 이전 서울플랜+ 사업장 ${kept}건 · 추진단계 ${planKept}건 · 도형 ${prevPlanZones.length}개 유지`);
    return;
  }
  const infoBySn = new Map(plan.infos.map((i) => [i.presentSn, i]));
  const propelNm = { ...PLAN_PROPEL };
  for (const i of plan.infos) if (i.propelCd && i.propelNm) propelNm[i.propelCd] = i.propelNm;
  const feats = plan.features.filter((f) => SEOULPLAN_TYPES[f.properties.type] && f.properties.type !== "BZ201");
  const baseZones = zones.filter((z) => !z.properties.dupOf && z.properties.src !== "parcel" && z.properties.src !== "seoulplan");
  const seoulAll = projects.filter((p) => (p.sido ?? "서울") === "서울");
  const seoulProjects = seoulAll.filter((p) => p.lat != null && p.lng != null);
  const byZone = new Map();
  for (const p of projects) if (p.zoneFid) (byZone.get(p.zoneFid) ?? byZone.set(p.zoneFid, []).get(p.zoneFid)).push(p);
  const used = new Set(projects.map((p) => p.no));
  let dupZ = 0, attached = 0, linked = 0, created = 0, newZones = 0, endedN = 0;
  const typeCount = {};
  for (const f of feats) {
    const fp = f.properties;
    const T = SEOULPLAN_TYPES[fp.type];
    const info = infoBySn.get(fp.presentSn);
    const stageNm = info?.propelNm || propelNm[fp.propelCd] || fp.propelCd || "";
    const hist = (info?.history ?? []).map((h) => ({ stage: propelNm[h.cd] ?? h.cd, date: h.date }));
    const cur = hist.filter((h) => h.stage === stageNm).map((h) => h.date).sort().pop() ?? hist[hist.length - 1]?.date ?? "";
    const isEnded = PLAN_ENDED.test(stageNm);
    const bb = bbox(f.geometry);
    const c = centroidOf(f.geometry);
    const planInfo = { sn: fp.presentSn, code: fp.type, type: T.nm, stage: stageNm, ...(cur ? { date: cur } : {}), history: hist, ...(isEnded ? { ended: true } : {}) };
    const url = seoulPlanUrl(fp.type);
    // 라벨용 동향: 별도 트랙(신통·역세권활성화·도심복합)이면 "신통 기획완료" 처럼 트랙 이름을 붙인다
    const kw = T.track ? `${T.track} ${stageNm}` : stageNm;
    const noteOf = () => (cur ? { date: cur, kw, title: `서울플랜+ ${T.nm} · ${stageNm}`, url, src: "서울플랜+" } : null);
    // 서울플랜+ 단계가 원자료 단계보다 앞서(같거나 뒤 단계) 있거나 별도 트랙일 때만 최근 동향으로 쓴다 — 옛 단계(이전고시 사업장에 '추진위구성')로 라벨이 후퇴하지 않게
    const RANK = ["계획", "추진위", "조합", "시행", "관리처분", "공사", "완료"];
    const rankOf = (s) => RANK.indexOf(stageGroup(s));
    const noteAllowed = (p) => T.track || isEnded || rankOf(stageNm) >= rankOf(rawStage(p.stage));
    const rawStage = (s) => (s ?? "").split(" · ")[0];
    // ① 같은 도형인 기존 구역
    const dup = baseZones.find(
      (z) => bboxOverlapRatio(bb, z.properties.bbox) >= 0.5 && pointInGeom(c, z.geometry) && pointInGeom(centroidOf(z.geometry), f.geometry) && sampledIoU({ geometry: f.geometry, properties: { bbox: bb } }, z, 20) >= 0.5,
    );
    if (dup) dupZ++;
    const ensureZone = () => {
      const fid = fp.presentSn;
      let z = zoneByFid.get(fid);
      if (!z) {
        z = {
          type: "Feature", geometry: f.geometry,
          properties: {
            fid, id: fid, name: (info?.name || fp.name || "").trim(), code: fp.type, gu: fp.gu || info?.guCode || "11000",
            area: Math.round(info?.area ?? fp.area ?? areaM2(f.geometry)), ntfc: "", bbox: bb, sido: "서울", src: "seoulplan",
          },
        };
        zones.push(z);
        zoneByFid.set(fid, z);
        newZones++;
      }
      return z;
    };
    // ② 유형이 맞는 기존 사업장: 같은 도형에 연결된 것 → 도형 안에 좌표가 있는 것 → 같은 구·같은 정규화 이름 순으로 찾는다
    const ok = (p) => !p.stale && p.source !== "서울플랜+" && p.source !== "모아타운" && planCompatible(T, p) &&
      // 취소·중단 기록은 시행인가 이후·완료된 사업장에는 붙이지 않는다 (옛 해제 구역이 준공 단지 자리에 남은 경우)
      !(isEnded && (DONE_RAW.test(rawStage(p.stage)) || rankOf(rawStage(p.stage)) >= 3));
    let cands = dup ? (byZone.get(dup.properties.fid) ?? []).filter(ok) : [];
    if (!cands.length) cands = seoulProjects.filter((p) => p.lng >= bb[0] && p.lng <= bb[2] && p.lat >= bb[1] && p.lat <= bb[3] && pointInGeom([p.lng, p.lat], f.geometry) && ok(p));
    if (!cands.length) {
      const nm = normName(info?.name || fp.name);
      const guNm = info?.gu || GU_BY_CODE[fp.gu];
      if (nm.length >= 2 && guNm) cands = seoulAll.filter((p) => p.gu === guNm && normName(p.name) === nm && ok(p));
      // 취소·중단 기록인데 같은 구·같은 이름의 사업장이 이미 있으면(준공·이전고시 등) 옛 해제 기록이 겹친 것 → 새 기록을 만들지 않는다
      if (!cands.length && isEnded && nm.length >= 2 && guNm && seoulAll.some((p) => p.gu === guNm && p.source !== "서울플랜+" && normName(p.name) === nm)) continue;
    }
    if (cands.length) {
      for (const p of cands) {
        if (!p.plan || (p.plan.date ?? "") <= cur) p.plan = planInfo;
        attached++;
        if (isEnded) endedN++;
        if (!p.zoneFid) {
          const z = dup ?? ensureZone();
          p.zoneFid = z.properties.fid;
          p.zoneId = z.properties.id;
          p.zoneHow = dup ? "point" : "seoulplan";
          (byZone.get(z.properties.fid) ?? byZone.set(z.properties.fid, []).get(z.properties.fid)).push(p);
          linked++;
        }
        const n = noteOf();
        if (n && noteAllowed(p) && (!p.note || (p.note.date ?? "") < cur)) p.note = n;
      }
      continue;
    }
    // ③ 새 기록
    const z = dup ?? ensureZone();
    const gu = info?.gu || GU_BY_CODE[fp.gu] || GU_BY_CODE[info?.guCode] || null;
    if (!gu) continue;
    const a = parseMoaAddr(info?.addr) ?? parseMoaAddr(info?.name) ?? parseMoaAddr(fp.name);
    const jibun = a ? `${a.dong} ${a.bon}` : "";
    const emd = jibun ? emdCodeOf(gu, jibun) : null;
    const base = (info?.name || fp.name || "").trim();
    const name = base ? (T.key.test(base) ? base : `${base} ${T.suffix}`) : `${T.nm} ${fp.presentSn}`;
    const p = {
      no: planNo(fp.presentSn, used), sido: "서울", gu, guCode: info?.guCode || GU_CODE[gu] || null, source: "서울플랜+",
      emdCode: emd?.code ?? null, pnu: emd?.pnu ?? null, kind: T.kind, name, jibun,
      loc: `서울특별시 ${gu} ${info?.addr || base}`, area: info?.area ?? fp.area ?? null,
      extra: [
        ["사업유형(서울플랜+)", T.nm],
        ["추진단계", `${stageNm}${cur ? ` · ${cur}` : ""}`],
        ...hist.filter((h) => !(h.stage === stageNm && h.date === cur)).map((h) => [`이력 · ${h.stage}`, h.date]),
        ...(info?.region ? [["권역", info.region]] : []),
      ],
      stage: stageNm || "단계 미기재", docs: "", cafe: null, map: null,
      lat: +c[1].toFixed(6), lng: +c[0].toFixed(6), locSrc: "zone",
      zoneId: z.properties.id, zoneFid: z.properties.fid, zoneHow: dup ? "point" : "seoulplan",
      note: noteOf(), plan: planInfo,
    };
    projects.push(p);
    (byZone.get(z.properties.fid) ?? byZone.set(z.properties.fid, []).get(z.properties.fid)).push(p);
    created++;
    if (isEnded) endedN++;
    typeCount[T.nm] = (typeCount[T.nm] ?? 0) + 1;
  }
  console.log(`· 서울플랜+ 도시계획사업 ${feats.length}건: 기존 구역과 같은 도형 ${dupZ} · 기존 사업장에 추진단계 부착 ${attached}(도형 연결 ${linked}) · 새 기록 ${created} (취소·중단 포함 ${endedN}) · 새 도형 ${newZones}개`);
  console.log(`  새 기록 유형: ${Object.entries(typeCount).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
}
/** 모아타운 위치 문구 → 법정동·본번 ("면목3,8동 453-1" → 면목동 453-1, "청룡동 1535" → 봉천동 1535) */
export function parseMoaAddr(s) {
  const t = (s ?? "").replace(/\[[^\]]*\]/g, "").replace(/(\d+),(\d+)동/, "$2동").replace(/\s+/g, " ").trim();
  const m = t.match(/([가-힣]+\d*(?:동|가))\s*(\d+(?:-\d+)?)/);
  if (!m) return null;
  return { dongAdm: m[1], dong: dongLegal(m[1]), bon: m[2] };
}
/** 모아타운 기록의 고정 번호: 법정동|본번 해시 → 119xxxxx (출처·순서가 바뀌어도 같은 곳은 같은 번호) */
function moaNo(key, used) {
  let h = 2166136261;
  for (const ch of key) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let no = 11900000 + (h % 90000);
  while (used.has(no)) no++;
  used.add(no);
  return no;
}

/**
 * 경기 — 일반 정비사업 추진현황 (경기데이터드림 시트 S62GFEEN7JMLMA0PH6CF19108891)
 * 공공데이터포털 15119846 은 파일이 없고 경기데이터드림으로 연결만 되므로, 화면이 쓰는 시트 조회(searchSheetData.do)를
 * 세션 쿠키 + CSRF 토큰과 함께 호출한다 (키 불필요, 100건씩 페이지).
 */
async function fetchGyeonggi() {
  const cache = path.join(RAW, "gyeonggi.json");
  const maxAge = 1000 * 60 * 60 * 24 * 7;
  let rows;
  if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < maxAge && !process.env.FORCE) {
    rows = JSON.parse(fs.readFileSync(cache, "utf8"));
    SOURCE_INFO.gyeonggi = new Date(fs.statSync(cache).mtimeMs).toISOString().slice(0, 10);
  } else {
    console.log("· 경기도 일반 정비사업 추진현황 (경기데이터드림)");
    SOURCE_INFO.gyeonggi = new Date().toISOString().slice(0, 10);
    try {
      const INF = "S62GFEEN7JMLMA0PH6CF19108891";
      const pageUrl = `https://data.gg.go.kr/portal/data/service/selectServicePage.do?infId=${INF}&infSeq=1`;
      const first = await fetch(pageUrl, { headers: { "User-Agent": UA } });
      const cookies = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
      const html = await first.text();
      const token = html.match(/<meta name="_csrf" content="([^"]+)"/)?.[1] ?? "";
      rows = [];
      for (let page = 1; page <= 20; page++) {
        const res = await fetch(`https://data.gg.go.kr/portal/data/sheet/searchSheetData.do?page=${page}`, {
          method: "POST",
          headers: {
            "User-Agent": UA, Cookie: cookies, Referer: pageUrl, "X-Requested-With": "XMLHttpRequest", "X-CSRF-TOKEN": token,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ infId: INF, infSeq: "1", rows: "100", _csrf: token }),
        });
        const j = await res.json();
        rows.push(...(j.data ?? []));
        if (page >= (j.pages ?? 1)) break;
        await sleep(300);
      }
      fs.writeFileSync(cache, JSON.stringify(rows));
    } catch (e) {
      console.warn("  ! 경기도 자료 내려받기 실패 — 건너뜀:", e.message);
      return [];
    }
  }
  const ymd = (s) => (s && /^\d{8}$/.test(String(s)) ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6, 8)}` : "");
  const out = rows
    .filter((r) => (r.imprv_zone_nm ?? "").trim())
    .map((r, i) => {
      const gu = (r.sigun_nm ?? "").trim();
      const extra = [
        ["토지등소유자", r.land_owner_cnt ? `${Number(r.land_owner_cnt).toLocaleString()}명` : ""],
        ["조합원", r.asocntmb_cnt ? `${Number(r.asocntmb_cnt).toLocaleString()}명` : ""],
        ["용적률", [r.existng_volumrt_desc ? `기존 ${r.existng_volumrt_desc}` : "", r.nwconst_volumrt_desc ? `계획 ${r.nwconst_volumrt_desc}` : ""].filter(Boolean).join(" → ")],
        ["정비구역지정", [ymd(r.imprv_zone_apnt_first_ymd), ymd(r.imprv_zone_apnt_chg_ymd) ? `변경 ${ymd(r.imprv_zone_apnt_chg_ymd)}` : ""].filter(Boolean).join(" · ")],
        ["추진위승인", ymd(r.proplsn_commisn_aprv_ymd)],
        ["조합설립인가", ymd(r.assoctn_fndn_confmtn_ymd)],
        ["사업시행인가", ymd(r.biz_enfc_confmtn_ymd)],
        ["관리처분인가", ymd(r.mng_dsps_confmtn_ymd)],
        ["착공", ymd(r.bgncst_ymd)],
        ["준공", ymd(r.cmcn_ymd)],
        ["이전고시", ymd(r.bf_ancmnt_ymd)],
        ["현추진상황", (r.now_proplsn_matr_desc ?? "").trim()],
        ["담당", (r.chrgpsn_telno ?? "").trim()],
      ].filter(([, v]) => v);
      const units = r.biz_enfc_hshld_noc_totsum ?? r.nwconst_lotout_housng_cnt;
      return {
        no: 41000000 + i + 1, sido: "경기", gu, guCode: sggCodeOf("경기도", gu), source: "경기도",
        kind: (r.biz_type_nm ?? "").trim(), name: (r.imprv_zone_nm ?? "").trim(), loc: (r.locplc_addr ?? "").trim(), jibun: "",
        area: Number(r.zone_ar) || null, stage: (r.biz_step_nm ?? "").trim(),
        docs: units ? `${Math.round(Number(units)).toLocaleString()}세대 (기존 ${Number(r.existng_housng_hshld_noc || 0).toLocaleString()})` : "",
        extra, cafe: null, map: null,
      };
    });
  console.log(`  ${out.length}건`);
  return out;
}

/** V-World 지구단위계획구역(UPIS UQ161) 레이어에서 경기·인천의 정비구역 이름을 가진 폴리곤 */
async function fetchVworldZones() {
  const cache = path.join(RAW, "vworld-zones.json");
  const maxAge = 1000 * 60 * 60 * 24 * 14;
  if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < maxAge && !process.env.FORCE) return JSON.parse(fs.readFileSync(cache, "utf8"));
  if (!VWORLD_KEY) return [];
  console.log("· V-World 지구단위계획 레이어에서 경기·인천 정비구역 폴리곤 수집");
  const BOX = "BOX(126.3,36.9,127.9,38.3)"; // 수도권
  const filters = ["재개발", "재건축", "정비구역", "촉진구역", "주거환경", "도시환경"];
  const byId = new Map();
  try {
  for (const f of filters) {
    for (let page = 1; page <= 5; page++) {
      const u = new URL("https://api.vworld.kr/req/data");
      u.search = new URLSearchParams({
        service: "data", request: "GetFeature", data: "LT_C_UPISUQ161", key: VWORLD_KEY, domain: VWORLD_DOMAIN, format: "json",
        size: "1000", page: String(page), geomFilter: BOX, attrFilter: `dgm_nm:like:${f}`, crs: "EPSG:4326",
      }).toString();
      const j = await (await fetch(u, { headers: { Referer: `https://${VWORLD_DOMAIN}/`, "User-Agent": UA } })).json();
      const feats = j.response?.result?.featureCollection?.features ?? [];
      for (const x of feats) {
        const p = x.properties;
        if ((p.signgu_se ?? "").startsWith("11")) continue; // 서울은 시 자료 사용
        if (!/^(41|28)/.test(p.signgu_se ?? "")) continue;
        byId.set(p.present_sn, x);
      }
      if (feats.length < 1000) break;
      await sleep(200);
    }
  }
  } catch (e) {
    // 해외 IP 차단 등으로 실패하면 캐시 → 이전 public/data 의 V-World 구역을 그대로 유지
    console.warn("  V-World 폴리곤 수집 실패:", e.message.slice(0, 80));
    if (fs.existsSync(cache)) {
      console.warn("  → data/raw 캐시 사용");
      return JSON.parse(fs.readFileSync(cache, "utf8"));
    }
    const prev = readJson(path.join(OUT, "zones.geojson"))?.features?.filter((z) => z.properties?.src === "vworld") ?? [];
    console.warn(`  → 이전 자료의 경기·인천 구역 ${prev.length}개 유지`);
    return prev;
  }
  const out = [...byId.values()].map((x) => {
    const p = x.properties;
    const n = p.dgm_nm ?? "";
    const code = /재건축/.test(n) ? "UQ1240" : /촉진/.test(n) ? "UQ5110" : /주거환경/.test(n) ? "UQ1211" : /도시환경|도시정비형/.test(n) ? "UQ1222" : "UQ1221";
    const g = x.geometry;
    // 좌표 소수 6자리
    const round = (c) => (typeof c[0] === "number" ? c.map((v) => +v.toFixed(6)) : c.map(round));
    g.coordinates = round(g.coordinates);
    return {
      type: "Feature",
      geometry: g,
      properties: {
        fid: p.present_sn, id: p.wtnnc_sn ?? p.present_sn, name: n.trim(), code, gu: p.signgu_se,
        area: Math.round(+p.dgm_ar || 0), ntfc: p.ntfc_sn ?? "", bbox: bbox(g).map((v) => +v.toFixed(6)),
        sido: p.signgu_se.startsWith("41") ? "경기" : "인천", src: "vworld",
      },
    };
  });
  fs.writeFileSync(cache, JSON.stringify(out));
  console.log(`  ${out.length}개`);
  return out;
}

/* ------------------------------------------------------------------ */
/**
 * 정비구역 폴리곤이 없는 재건축 단지 → 대표지번 필지 경계 (V-World 연속지적도 LP_PA_CBND_BUBUN).
 * 압구정 3·4·5구역처럼 조합은 있는데 정비구역이 아직 지정되지 않은(또는 SHP 에 없는) 단지가 지도에 점으로만 보이던 문제
 * (2026-09-08 부팀장 지적). 아파트 단지는 대지 한 필지가 단지 경계와 거의 같으므로 지목 '대' 이고 면적이 충분할 때만 쓴다
 * (재개발·단독주택 재건축의 대표지번은 500~2,000㎡ 짜리 한 필지라 제외). 재개발 구역은 필지 여러 개라 이 방법이 맞지 않는다.
 */
export const PARCEL_KIND = /재건축|리모델링/;
export const PARCEL_MIN_AREA = (kind) => (/소규모/.test(kind) ? 1500 : 3000);
export const parcelCachePath = path.join(RAW, "parcels.json");
let parcelDown = false;

/** 위경도 폴리곤 면적(㎡) — 위도 보정한 평면 근사 (수도권 범위에서 0.1% 이내) */
export function areaM2(g) {
  const rings = g.type === "Polygon" ? [g.coordinates[0]] : g.coordinates.map((p) => p[0]);
  let A = 0;
  for (const r of rings) {
    if (!r?.length) continue;
    const kx = 111320 * Math.cos((r[0][1] * Math.PI) / 180), ky = 110540;
    let s = 0;
    for (let i = 0; i < r.length - 1; i++) s += r[i][0] * kx * (r[i + 1][1] * ky) - r[i + 1][0] * kx * (r[i][1] * ky);
    A += Math.abs(s) / 2;
  }
  return A;
}

async function fetchParcel(p, cache) {
  const ck = p.pnu ? `pnu:${p.pnu}` : `pt:${p.lng},${p.lat}`;
  // 장소 검색 지점의 필지 합치기(addParcelZones)는 규모 기준을 낮춰(minArea) 부르는데, 캐시에 '규모 미달' 로만 남은 필지는 다시 조회한다
  const min = p.minArea ?? PARCEL_MIN_AREA(p.kind);
  if (ck in cache) {
    const c = cache[ck];
    const m = c?.skip?.match(/대\s*(\d+)㎡$/);
    if (!(p.minArea != null && m && +m[1] >= min)) return c;
  }
  if (!VWORLD_KEY || parcelDown) return undefined;
  const u = new URL("https://api.vworld.kr/req/data");
  const o = { service: "data", request: "GetFeature", data: "LP_PA_CBND_BUBUN", key: VWORLD_KEY, domain: VWORLD_DOMAIN, format: "json", size: "3", page: "1", crs: "EPSG:4326" };
  if (p.pnu) o.attrFilter = `pnu:=:${p.pnu}`;
  else o.geomFilter = `POINT(${p.lng} ${p.lat})`;
  u.search = new URLSearchParams(o).toString();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const j = await (await fetch(u, { headers: { Referer: `https://${VWORLD_DOMAIN}/`, "User-Agent": UA } })).json();
      const st = j.response?.status;
      if (st === "ERROR") throw new Error(j.response?.error?.text ?? "V-World 오류");
      const f = j.response?.result?.featureCollection?.features?.[0];
      let v = null;
      if (f?.geometry) {
        const jibun = (f.properties?.jibun ?? "").trim();
        const area = Math.round(areaM2(f.geometry));
        // 지목이 '대'(대지)이고 단지 규모일 때만
        if (/대$/.test(jibun) && area >= min) {
          const round = (c) => (typeof c[0] === "number" ? c.map((x) => +x.toFixed(6)) : c.map(round));
          v = { geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) }, pnu: f.properties.pnu, jibun, addr: f.properties.addr, area };
        } else v = { skip: `${jibun || "지목?"} ${area}㎡` };
      }
      cache[ck] = v;
      await sleep(80);
      return v;
    } catch (e) {
      if (attempt === 3) {
        console.warn("  필지 조회 오류", p.name, e.message);
        if (++vworldFails >= 3) parcelDown = true;
      }
      await sleep(2000 * attempt);
    }
  }
  return undefined;
}

/**
 * 완공 판별 — 사업장이 연결되지 않은 최근(OLD_ZONE_YEAR 이후) 정비구역이 이미 다 지어졸 곳인지 V-World GIS건물통합정보
 * (LT_C_BLDGINFO)로 본다. 신축 아파트는 건축물대장 결합 전이라 사용승인일이 비어 있고 층수만 있으므로,
 * "구역 안에 승인일 없는 10층 이상 건물" 또는 "지정 이후 승인된 10층 이상 건물" 이 3동 이상(작은 구역은 1동)이면 준공으로 본다.
 * 2026-09-08 확인: 아현1-3·아현2·아현4·흑석3(준공) 6~21동, 한남3(진행) 0동. 촉진지구·도시개발구역 울타리는 제외.
 */
export const builtCachePath = path.join(RAW, "built.json");
let builtDown = false;

export function centroidOf(g) {
  const r = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0];
  let x = 0, y = 0;
  for (const c of r) { x += c[0]; y += c[1]; }
  return [x / r.length, y / r.length];
}

export async function fetchBuiltSignal(z, cache) {
  const zp = z.properties;
  const ck = `${zp.fid}|${zp.ntfc}`;
  if (ck in cache) return cache[ck];
  if (!VWORLD_KEY || builtDown) return undefined;
  const y0 = +((zp.ntfc ?? "").match(/NTC(\d{4})/)?.[1] ?? 0);
  const box = `BOX(${zp.bbox.join(",")})`;
  let nullTall = 0, newTall = 0, n = 0;
  try {
    for (let page = 1; page <= 5; page++) {
      const u = new URL("https://api.vworld.kr/req/data");
      u.search = new URLSearchParams({
        service: "data", request: "GetFeature", data: "LT_C_BLDGINFO", key: VWORLD_KEY, domain: VWORLD_DOMAIN, format: "json",
        crs: "EPSG:4326", size: "1000", page: String(page), geomFilter: box,
      }).toString();
      const j = await (await fetch(u, { headers: { Referer: `https://${VWORLD_DOMAIN}/`, "User-Agent": UA }, signal: AbortSignal.timeout(30000) })).json();
      const st = j.response?.status;
      if (st === "NOT_FOUND") break;
      if (st !== "OK") throw new Error(j.response?.error?.text ?? st ?? "V-World 오류");
      const feats = j.response.result?.featureCollection?.features ?? [];
      for (const f of feats) {
        if (!f.geometry || !pointInGeom(centroidOf(f.geometry), z.geometry)) continue;
        n++;
        const fl = +(f.properties?.grnd_flr ?? 0);
        const ap = String(f.properties?.useapr_day ?? "");
        const y = +ap.slice(0, 4) || 0;
        if (fl >= 10 && !y) nullTall++;
        else if (fl >= 10 && y0 && y >= y0 + 1) newTall++;
      }
      const total = +(j.response.record?.total ?? 0);
      if (feats.length < 1000 || page * 1000 >= total) break;
      await sleep(80);
    }
    const v = { tall: nullTall + newTall, n };
    cache[ck] = v;
    vworldFails = 0;
    await sleep(80);
    return v;
  } catch (e) {
    console.warn("  건물 조회 오류", zp.name, e.message.slice(0, 60));
    if (++vworldFails >= 3) builtDown = true;
    return undefined;
  }
}

/** 후기 단계(관리처분·이주·철거·착공·분양)인데 아직 완료로 안 바뀐 사업장 — 준공 뒤 자료 갱신이 늦는 경우가 있다 */
export const LATE_STAGE = (s) => /관리처분|착공|철거|분양|이주/.test(s ?? "") && !/준공|청산|해산|이전고시|입주/.test(s ?? "");

/**
 * 건물 판별(V-World 건물통합정보) 대상 구역인가. linked = 그 시점에 연결된 사업장(없으면 undefined).
 * 주의: 필지 경계(src parcel)는 markBuiltZones 뒤에 addParcelZones 가 만들므로 실제로는 검사 대상이 되지 않는다
 *  (옛 고층 단지의 '대장 미결합' 건물을 신축으로 오판할 위험이 있어 그대로 둔다)
 */
export function builtCandidacy(zp, linked) {
  if (UMBRELLA_CODE.test(zp.code)) return { ok: false, reason: "울타리 구역(촉진지구·도시개발)" };
  if (zp.dupOf) return { ok: false, reason: "고시 차수 중복 도형(dupOf) — 대표 도형에서 판별" };
  if (linked) {
    const live = linked.filter((p) => !p.stale && !p.doneBy && !p.useApr); // 통합 전 옛 기록·준공 추정·사용승인 확인 기록은 빼고 본다
    if (!live.length) return { ok: false, reason: "연결 기록이 모두 옛 기록·준공 추정·사용승인 확인 → 앱에서 이미 완공" };
    // 연결 사업장이 모두 후기 단계면 준공됐는지 본다 (2026-09-08 확인: 행당7·이문3·방배5·도곡삼호 등 10곳이 단계만 옛 값)
    if (!live.every((p) => LATE_STAGE(p.stage))) return { ok: false, reason: "연결 사업장에 후기 단계(관리처분~분양) 아닌 기록 있음 (초기 단계 구역은 옛 고층 단지 오탐 100%)" };
    if ((zp.area ?? 0) >= 300000) return { ok: false, reason: "면적 30만㎡ 이상" };
    return { ok: true, reason: "연결 사업장 모두 후기 단계" };
  }
  if (zp.src === "parcel" || zp.src === "special" || zp.src === "seoulplan") return { ok: false, reason: "사업장 미연결 필지·특별계획·모아타운 도형" };
  const y = +((zp.ntfc ?? "").match(/NTC(\d{4})/)?.[1] ?? 0);
  if (y < 2010) return { ok: false, reason: `고시 ${y || "미상"} — 2010년 이전은 앱에서 이미 '과거 구역'` };
  return { ok: true, reason: "사업장 미연결 2010년 이후 구역" };
}
/** 신축 고층 동수(tall)로 준공 판정 — 3동 이상, 또는 1동 이상이면서 1만㎡ 미만 구역 */
export const builtVerdict = (tall, area) => tall >= 3 || (tall >= 1 && (area ?? 0) < 10000);
async function markBuiltZones(zones, projects, prevZones) {
  const byFid = new Map();
  for (const p of projects) if (p.zoneFid) (byFid.get(p.zoneFid) ?? byFid.set(p.zoneFid, []).get(p.zoneFid)).push(p);
  const cands = zones.filter((z) => builtCandidacy(z.properties, byFid.get(z.properties.fid)).ok);
  console.log(`· 사업장 미연결 최근 구역 + 후기 단계 구역 ${cands.length}개 → 신축 건물로 완공 여부 판별 (V-World 건물통합정보)`);
  const cache = fs.existsSync(builtCachePath) ? JSON.parse(fs.readFileSync(builtCachePath, "utf8")) : {};
  const prevBuilt = new Map((prevZones?.features ?? []).filter((f) => f.properties?.built != null).map((f) => [f.properties.fid, f.properties]));
  const prevProjBuilt = new Set((readJson(path.join(OUT, "projects.json")) ?? []).filter((p) => p?.built).map((p) => p.no));
  let built = 0, kept = 0, i = 0, projDone = 0;
  for (const z of cands) {
    if (++i % 100 === 0) {
      process.stdout.write(`  ${i}/${cands.length}\n`);
      fs.writeFileSync(builtCachePath, JSON.stringify(cache));
    }
    const r = await fetchBuiltSignal(z, cache);
    if (r) {
      // 판정은 캐시된 동수로 매번 계산 (규칙을 바꿔도 캐시 재사용). 고시 연도는 최신 변경·해제 고시라 "최근 지정" 제외에 못 쓴다.
      // 검증(2026-09-08, 정보몽땅 단계가 확실한 구역): 완료 45곳 중 36곳 적중, 진행 45곳 중 오탐 1곳, 공사 중 25곳 중 3곳
      const tall = r.tall ?? 0;
      z.properties.built = builtVerdict(tall, z.properties.area);
      z.properties.builtN = tall;
      if (z.properties.built) built++;
    } else if (prevBuilt.has(z.properties.fid)) {
      z.properties.built = prevBuilt.get(z.properties.fid).built;
      z.properties.builtN = prevBuilt.get(z.properties.fid).builtN;
      if (z.properties.built) built++;
      kept++;
    }
    // 후기 단계 사업장이 연결된 구역이 준공으로 판별되면 그 사업장도 완료로 (앱에서 단계 뒤에 "준공(건물 확인)" 을 붙여 완공으로 분류)
    const linked = (byFid.get(z.properties.fid) ?? []).filter((p) => !p.stale && !p.doneBy && !p.useApr);
    if (linked.length) {
      const done = z.properties.built === true || (r === undefined && linked.some((p) => prevProjBuilt.has(p.no)));
      if (done) for (const p of linked) if (!p.built) { p.built = true; projDone++; }
    }
  }
  fs.writeFileSync(builtCachePath, JSON.stringify(cache));
  console.log(`  완공으로 판별 ${built}개${kept ? ` (이전 자료 유지 ${kept})` : ""}, 후기 단계 사업장 완료 처리 ${projDone}건`);
}

async function addParcelZones(projects, zones, prevZones) {
  const cands = projects.filter((p) => !p.zoneFid && !p.stale && p.lat != null && p.lng != null && PARCEL_KIND.test(p.kind) && !/소규모재개발/.test(p.kind));
  console.log(`· 정비구역 폴리곤 없는 재건축·리모델링 단지 ${cands.length}건 → 대표지번 필지 경계 (V-World 지적도)`);
  const cache = fs.existsSync(parcelCachePath) ? JSON.parse(fs.readFileSync(parcelCachePath, "utf8")) : {};
  const prevByFid = new Map((prevZones?.features ?? []).filter((f) => f.properties?.src === "parcel").map((f) => [f.properties.fid, f]));
  let n = 0, kept = 0, skipped = 0;
  for (const p of cands) {
    const fid = `P${p.no}`;
    let feat = null;
    let r;
    // 대표지번 필지 하나가 단지 전체가 아닐 수 있다(여러 필지로 나뉜 단지, 여러 단지가 한 사업, 대표지번·장소점이 상가·도로·제방 필지).
    // → 구성 단지(1기 신도시) 또는 이름에서 나눈 단지들("하안주공10·11단지" → 10단지·11단지, 단일 단지면 그 이름)을 장소 검색해
    //   나온 지점(단지·동·입구, 최대 4곳)마다 필지를 조회하고, 지목 '대'·규모 이상인 서로 다른 필지를 모두 합친다(MultiPolygon).
    //   단일 단지는 대표지번 필지가 규모를 채우면 그대로 쓰고, 작거나 지목이 다를 때만 장소 검색으로 보충한다.
    //   (2026-09-08 아실 비교: 하안주공3·4단지가 한 단지 필지만, 10·11단지 33,927㎡(실제 13만㎡), 양재우성 154-2 대 1,689㎡(단지가 여러 필지), 철산주공12단지 장소점이 제방 필지)
    const queries = p.complexes ?? placeQueries(p.gu, p.name).map((q) => ({ q: q.query, core: q.core }));
    const single = !p.complexes && queries.length < 2;
    r = single || !queries.length ? await fetchParcel(p, cache) : undefined;
    if (!(single && r?.geometry) && queries.length) {
      const polys = [];
      const seenPnu = new Set();
      let area = 0;
      const found = [];
      const add = (rr, label) => {
        if (!rr?.geometry) return false;
        if (rr.pnu && seenPnu.has(rr.pnu)) {
          if (label && !found.includes(label)) found.push(label); // 같은 필지를 쓰는 단지(3·4단지가 한 필지)도 '찾은 단지'로
          return false;
        }
        if (rr.pnu) seenPnu.add(rr.pnu);
        const g = rr.geometry;
        polys.push(...(g.type === "Polygon" ? [g.coordinates] : g.coordinates));
        area += rr.area;
        if (label && !found.includes(label)) found.push(label);
        return true;
      };
      if (!single && !p.complexes) add(await fetchParcel(p, cache), null); // 여러 단지 사업: 대표지번 필지도 포함
      for (const c of queries) {
        const label = c.core.split("|")[0].trim();
        // 단지 이름 대안("양지5단지 한양|양지마을 한양5단지")은 하나만 맞으면 된다; 맞은 대안의 검색 지점은 모두 조회
        for (const alt of c.core.split("|")) {
          let hit = false;
          // 단지 안 지점(동·입구)의 필지는 동마다 필지가 나뉜 단지(양재우성 153·137-1·138-3…)도 있어 500㎡ 부터 받고, 합친 면적이 규모 기준을 채워야 쓴다
          for (const pt of await searchPlaceItems(`${p.gu.split(" ")[0]} ${alt.trim()}`, SIDO_FULL[p.sido], p.gu, alt.trim())) {
            if (add(await fetchParcel({ ...p, pnu: null, lng: pt.lng, lat: pt.lat, minArea: 500 }, cache), label)) hit = true;
          }
          if (hit) break;
        }
      }
      if (polys.length && area >= PARCEL_MIN_AREA(p.kind)) {
        r = { geometry: { type: "MultiPolygon", coordinates: polys }, area, pnu: null, addr: `${found.length}/${queries.length} 단지 필지: ${found.join(" · ")}${seenPnu.size > 1 ? ` (${seenPnu.size}필지, 장소 검색 지점 기준이라 일부일 수 있음)` : ""}` };
      } else if (polys.length) {
        r = { skip: `필지 합계 ${Math.round(area)}㎡ 규모 미달` };
      } else if (r === undefined) {
        // V-World 를 못 쓰는 환경이면 undefined 로 두어 아래에서 이전 자료를 유지한다
        r = p.complexes ? (parcelDown || vworldDown ? undefined : { skip: "단지 필지 없음" }) : await fetchParcel(p, cache);
      }
    }
    if (r?.geometry) {
      const g = r.geometry;
      feat = {
        type: "Feature",
        geometry: g,
        properties: {
          fid, id: fid, name: p.name, code: /소규모/.test(p.kind) ? "UQ1270" : "UQ1240", gu: p.guCode ?? "", area: r.area, ntfc: "",
          bbox: bbox(g).map((v) => +v.toFixed(6)), sido: p.sido ?? "서울", src: "parcel", pnu: r.pnu ?? null, jibun: r.addr ?? r.jibun ?? "",
        },
      };
      n++;
    } else if (r === undefined && prevByFid.has(fid)) {
      // V-World 를 못 쓰는 환경(러너)에서는 이전 자료의 필지 경계 유지
      feat = prevByFid.get(fid);
      kept++;
    } else if (r?.skip) skipped++;
    if (feat) {
      zones.push(feat);
      p.zoneFid = fid;
      p.zoneId = fid;
      p.zoneHow = "parcel";
    }
  }
  fs.writeFileSync(parcelCachePath, JSON.stringify(cache));
  fs.writeFileSync(geoCachePath, JSON.stringify(geoCache)); // 단지 장소 검색 결과도 캐시에
  console.log(`  필지 경계 ${n}건${kept ? ` (+이전 자료 유지 ${kept})` : ""}, 규모·지목 미달로 제외 ${skipped}건`);
}

async function main() {
  // 변경 비교용 이전 구역 자료 (zones.geojson 은 아래에서 덮어쓰므로 먼저 읽는다)
  const prevZones = readJson(path.join(OUT, "zones.geojson"));
  const shp = await downloadShp();
  const seoulZones = await buildZones(shp);
  for (const z of seoulZones) {
    z.properties.sido = "서울";
    z.properties.src = "seoul";
  }
  const extraZones = await fetchVworldZones();
  // 모아타운: 서울플랜+ 도형(+추진단계) — 실패하면 이전 zones 의 모아타운 도형을 유지(연결은 못 하므로 앱에서 '과거'로 숨김)
  const plan = await fetchSeoulPlan();
  const moa = await fetchMoatown(planSubset(plan, ["BZ201"]));
  const moaZones = moa.zones.length ? moa.zones : (prevZones?.features ?? []).filter((f) => f.properties?.src === "seoulplan");
  const zones = [...seoulZones, ...extraZones, ...moaZones];
  console.log(`  구역 합계 ${zones.length}개 (서울 SHP ${seoulZones.length} + V-World ${extraZones.length} + 모아타운 ${moaZones.length})`);
  // 같은 구역이 고시 차수별로 여러 도형으로 들어 있으면(신반포3차·경남 2017/2018 등) 최신 고시를 대표로 삼고 나머지는 dupOf 로 숨긴다
  const dupOf = groupDuplicateZones(zones);
  const zoneByFid = new Map(zones.map((z) => [z.properties.fid, z]));
  const byId = new Map();
  for (const z of zones) {
    if (!byId.has(z.properties.id)) byId.set(z.properties.id, []);
    byId.get(z.properties.id).push(z);
  }
  const zoneNorm = zones.filter((z) => !z.properties.dupOf).map((z) => ({ z, n: normName(z.properties.name), c: centerOf(z.properties.bbox) }));

  // 출처별 수집 — 실패(해외 IP 차단·타임아웃 등)하거나 0건이면 이전 projects.json 의 그 시도 사업장을 그대로 유지
  const prevProjects = readJson(path.join(OUT, "projects.json")) ?? [];
  const prevMeta = readJson(path.join(OUT, "meta.json"));
  async function collect(sido, key, fn) {
    try {
      const rows = await fn();
      if (rows.length) return rows;
      throw new Error("0건");
    } catch (e) {
      const keep = Array.isArray(prevProjects) ? prevProjects.filter((p) => p.sido === sido) : [];
      console.warn(`  ! ${sido} 수집 실패(${String(e.message).slice(0, 60)}) → 이전 자료 ${keep.length}건 유지`);
      if (prevMeta?.sources?.[key]) SOURCE_INFO[key] = prevMeta.sources[key];
      return keep;
    }
  }
  const seoulList = await collect("서울", "cleanup", async () => (await fetchCleanupList()).map((p) => ({ ...p, sido: "서울", source: "정보몽땅" })));
  const gyeonggiList = await collect("경기", "gyeonggi", fetchGyeonggi);
  const incheonList = await collect("인천", "incheon", fetchIncheon);
  // 지자체 정비사업 포털(서초구·광명시): 정보몽땅·경기 시트에 없는 안전진단·기본계획·최근 지정 구역을 보충 — 좌표가 나온 뒤 dedupeGuPortal 로 다시 걸러낸다
  const portalList = await fetchGuPortals([...seoulList, ...gyeonggiList, ...incheonList], prevProjects);
  const list = [...seoulList, ...gyeonggiList, ...incheonList, ...portalList, ...fetchNewtown(), ...moa.projects];
  if (!list.length) throw new Error("사업장 자료를 하나도 얻지 못함");
  console.log(`· 사업장 ${list.length}건 지오코딩 + 결합`);
  seedGeoCacheFromPrevious();
  const board = await fetchCleanupBoard();

  const projects = [];
  let stat = { geo: 0, place: 0, emd: 0, byPreset: 0, byMap: 0, byPoint: 0, byName: 0, zoneLoc: 0, none: 0 };
  let i = 0;
  for (const p of list) {
    i++;
    if (i % 100 === 0) {
      process.stdout.write(`  ${i}/${list.length}\n`);
      fs.writeFileSync(geoCachePath, JSON.stringify(geoCache));
    }
    let loc = null;
    const cands =
      p.sido === "서울"
        ? addressCandidates(p.gu, p.jibun).map((address) => ({ address, type: "PARCEL" }))
        : locCandidates(SIDO_FULL[p.sido], p.gu, p.loc);
    for (const c of cands) {
      loc = await geocode(c.address, c.type);
      if (loc) break;
    }
    if (loc) stat.geo++;
    // 지번으로 못 찾으면(위치 열이 비었거나 준공 후 지번 합병) 단지명으로 장소 검색 (2026-09-08, 광명 하안주공 등)
    let byPlace = false, byEmd = false;
    // 1기 신도시 선도지구: 구성 단지 이름으로 (첫 단지 위치)
    if (!loc && p.complexes) {
      for (const c of p.complexes) {
        const alt = c.core.split("|")[0].trim();
        loc = await searchPlace(`${p.gu.split(" ")[0]} ${alt}`, SIDO_FULL[p.sido], p.gu, alt);
        if (loc) {
          byPlace = true;
          stat.place++;
          break;
        }
      }
    }
    if (!loc) {
      for (const q of placeQueries(p.gu, p.name)) {
        loc = await searchPlace(q.query, SIDO_FULL[p.sido], p.gu, q.core);
        if (loc) {
          byPlace = true;
          stat.place++;
          break;
        }
      }
    }
    // 그래도 없고 준공·청산된 곳(지번 합병)이면 법정동 중심 — 구역 결합(아래)이 되면 구역 중심이 우선
    let emdLoc = null;
    if (!loc && /준공|청산|해산|완료|이전고시/.test(p.stage ?? "")) {
      for (const d of dongsOf(cands)) {
        emdLoc = await searchDistrict(d);
        if (emdLoc) break;
      }
    }
    const pn = normName(p.name);

    let zone = null, how = null;
    // (0) 출처가 도형을 함께 주는 경우 (서울플랜+ 모아타운) — 기록에 미리 정해진 도형
    if (p.presetZone && zoneByFid.has(p.presetZone.fid)) {
      zone = zoneByFid.get(p.presetZone.fid);
      how = p.presetZone.how;
      stat.byPreset++;
    }
    // (a) 정보몽땅 지도 코드 = 결정고시 관리코드 (자리표시 코드는 제외)
    if (!zone && p.map && p.map !== PLACEHOLDER_AGZ && byId.has(p.map)) {
      zone = pickBest(byId.get(p.map), pn, loc);
      how = "map";
      stat.byMap++;
    }
    // (b) 대표지번 좌표가 들어있는 구역 (이름 유사도로 우선순위) — 같은 시도 안에서만.
    //     유형이 어울려야 하고, 촉진지구·존치·도시개발·주거환경관리 같은 울타리 폴리곤은 이름까지 맞을 때만,
    //     이름의 숫자가 서로 다르면(영등포1-5 vs 1-12) 제외
    if (!zone && loc && kindClass(p.kind) !== "none") {
      const pt = [loc.lng, loc.lat];
      const hits = zones.filter((z) => {
        const zp = z.properties;
        if ((zp.sido ?? "서울") !== (p.sido ?? "서울") || zp.dupOf) return false;
        const b = zp.bbox;
        if (!(pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3] && pointInGeom(pt, z.geometry))) return false;
        if (!compatible(p.kind, zp.code)) return false;
        const zn = normName(zp.name);
        if (digitsConflict(pn, zn)) return false;
        // 울타리 폴리곤(촉진지구 전체 43~119ha 등)은 이름이 거의 같을 때만, 존치·관리형은 이름이 비슷할 때만
        const s = nameScore(pn, zn);
        if (/^UQ51[012]/.test(zp.code) && s < 0.8) return false;
        if ((UMBRELLA_CODE.test(zp.code) || zp.code === MANAGED_CODE) && s < 0.5) return false;
        return true;
      });
      if (hits.length) {
        zone = pickBest(hits, pn, loc);
        how = "point";
        stat.byPoint++;
      }
    }
    // (c) 이름 매칭 — 유형이 어울리는 구역만. 좌표가 있으면 1km 이내(이름이 거의 같으면 3km), 없으면 시도 안에서 유일할 때만
    if (!zone && pn.length >= 3 && kindClass(p.kind) !== "none") {
      const cands = zoneNorm
        .filter((x) => (x.z.properties.sido ?? "서울") === (p.sido ?? "서울") && compatible(p.kind, x.z.properties.code))
        .map((x) => ({ ...x, s: nameScore(pn, x.n) }))
        .filter((x) => x.s >= (/^UQ51[012]/.test(x.z.properties.code) ? 0.8 : 0.5) && (!loc || distKm(loc, x.c) <= (x.s >= 0.8 ? 3 : 1)));
      cands.sort((a, b) => b.s - a.s);
      if (cands.length && (cands.length === 1 || cands[0].s - cands[1].s > 0.15 || cands[0].z.properties.id === cands[1].z.properties.id)) {
        zone = cands[0].z;
        how = "name";
        stat.byName++;
      }
    }
    if (!loc && zone) {
      loc = centerOf(zone.properties.bbox);
      stat.zoneLoc++;
    }
    if (!loc && emdLoc) {
      loc = emdLoc;
      byEmd = true;
      stat.emd++;
    }
    if (!loc) stat.none++;

    const emd = p.sido === "서울" ? emdCodeOf(p.gu, p.jibun) : null;
    projects.push({
      no: p.no,
      sido: p.sido ?? "서울",
      gu: p.gu,
      guCode: p.sido === "서울" ? (GU_CODE[p.gu] ?? null) : (p.guCode ?? null),
      source: p.source ?? "정보몽땅",
      emdCode: emd?.code ?? null,
      pnu: emd?.pnu ?? null,
      kind: p.kind,
      name: p.name,
      // 경기 시트는 위치가 비면 "경기도 광명시 nan" 으로 옴 → 빈 값으로
      jibun: p.jibun || (p.loc && !/\bnan$/i.test(p.loc) ? p.loc.replace(/\s*일원|\s*일대/g, "").slice(0, 40) : ""),
      loc: /\bnan$/i.test(p.loc ?? "") ? "" : (p.loc ?? ""),
      area: p.area ?? null,
      extra: p.extra ?? undefined,
      stage: p.stage,
      docs: p.docs,
      cafe: p.cafe,
      map: p.map,
      lat: loc?.lat ?? null,
      lng: loc?.lng ?? null,
      locSrc: loc ? (byPlace ? "place" : byEmd ? "emd" : how && !geoCacheHit(p) ? "zone" : "geocode") : null,
      zoneId: zone?.properties.id ?? null,
      zoneFid: zone?.properties.fid ?? null,
      zoneHow: how,
      note: p.note ?? noteFor(p, board),
      ...(p.complexes ? { complexes: p.complexes } : {}),
      ...(p.portal ? { portal: p.portal } : {}),
    });
  }
  fs.writeFileSync(geoCachePath, JSON.stringify(geoCache));

  /* ---- 숨긴 중복 도형에 연결된 사업장은 대표 도형으로 (정보몽땅 지도 코드가 옛 고시의 관리코드인 경우 등) ---- */
  let remapped = 0;
  for (const p of projects) {
    if (!p.zoneFid || !dupOf.has(p.zoneFid)) continue;
    const rep = zoneByFid.get(dupOf.get(p.zoneFid));
    p.zoneFid = rep.properties.fid;
    p.zoneId = rep.properties.id;
    remapped++;
  }
  if (remapped) console.log(`  중복 도형에 연결된 사업장 ${remapped}건을 대표 도형으로 이동`);
  /* ---- 지자체포털 후보 중 좌표로 보아 기존 기록·서울플랜+ 도형과 겹치는 것 제외 ---- */
  dedupeGuPortal(projects, plan, prevProjects, zoneByFid);
  /* ---- 서울플랜+ 도시계획사업(신속통합기획·가로주택·리모델링·역세권 …): 기존 사업장에 추진단계 부착, 없는 곳은 새 기록 + 도형 ---- */
  applySeoulPlan(projects, zones, plan, prevZones, prevProjects, zoneByFid);
  /* ---- 통합 전 옛 기록(정보몽땅에 남은 것) 표시 → 앱은 완공으로 ---- */
  markStaleRecords(projects, dupOf);
  /* ---- 서울시 착공 중·이주완료 구역 목록(서울주택정보마당)으로 단계 보정, 목록에 없는 착공·분양 기록은 준공 추정 ---- */
  applyHousingInfo(projects, await fetchHousingInfo());
  /* ---- 건축물대장 총괄표제부 사용승인일로 후기 단계 사업장 준공 확정 ---- */
  zoneByFidGlobal = zoneByFid;
  await applyBuildingRegistry(projects);

  /* ---- 정비구역이 없는 사업장: 지구단위계획 특별계획구역 경계 (압구정 3~5구역 등) ---- */
  linkSpecialZones(projects, zones, await buildSpecialZones(), prevZones);
  /* ---- 사업장 미연결 구역: 신축 건물로 완공 판별 ---- */
  await markBuiltZones(zones, projects, prevZones);
  markStaleRecords(projects, dupOf); // 후속 기록이 건물 자료로 완료 처리된 경우까지
  /* ---- 정비구역 폴리곤이 없는 재건축 단지는 대표지번 필지 경계로 ---- */
  await addParcelZones(projects, zones, prevZones);
  fs.writeFileSync(path.join(OUT, "zones.geojson"), JSON.stringify({ type: "FeatureCollection", features: zones }));
  console.log(`  zones.geojson ${zones.length}개, ${(fs.statSync(path.join(OUT, "zones.geojson")).size / 1e6).toFixed(2)} MB`);

  /* ---- 이전 자료와 비교해 변경 내역(신규 구역·사업장, 단계 변경) 기록 ---- */
  const changes = diffAgainstPrevious(zones, projects, prevZones);

  fs.writeFileSync(path.join(OUT, "projects.json"), JSON.stringify(projects));
  fs.writeFileSync(
    path.join(OUT, "meta.json"),
    JSON.stringify({
      builtAt: new Date().toISOString(),
      zones: zones.length,
      projects: projects.length,
      shp: path.basename(shp),
      sources: {
        seoulShp: SOURCE_INFO.seoulShp,
        cleanup: SOURCE_INFO.cleanup,
        gyeonggi: SOURCE_INFO.gyeonggi,
        incheon: SOURCE_INFO.incheon,
        vworld: extraZones.length ? new Date().toISOString().slice(0, 10) : "",
        housinginfo: SOURCE_INFO.housinginfo ?? "",
        bldrgst: SOURCE_INFO.bldrgst ?? "",
        seoulplan: plan?.fetchedAt ?? prevMeta?.sources?.seoulplan ?? "",
        portal: SOURCE_INFO.portal || prevMeta?.sources?.portal || "",
      },
      changes: changes.added,
    }),
  );
  const bySido = {};
  for (const p of projects) {
    const k = p.sido;
    bySido[k] ??= { n: 0, geo: 0, zone: 0 };
    bySido[k].n++;
    if (p.lat != null) bySido[k].geo++;
    if (p.zoneFid) bySido[k].zone++;
  }
  console.log("· 결과", stat, bySido);
  console.log(`  projects.json ${(fs.statSync(path.join(OUT, "projects.json")).size / 1e3).toFixed(0)} KB`);

  /* ---- 정답 목록(data/truth.json)과 비교하는 회귀 검사 — 위반이 있어도 빌드는 실패시키지 않고 출력만 ---- */
  try {
    const { runAudit } = await import("./audit.mjs");
    runAudit({ projects, zones });
  } catch (e) {
    console.warn("  회귀 검사 실행 실패:", e.message);
  }

  /** 이전 projects.json 에서 지오코딩으로 얻은 좌표를 캐시에 미리 넣어 V-World 없이도 기존 사업장 좌표가 유지되게 한다 */
  function seedGeoCacheFromPrevious() {
    const prev = readJson(path.join(OUT, "projects.json"));
    if (!Array.isArray(prev)) return;
    let n = 0;
    for (const p of prev) {
      if (p.lat == null || p.lng == null) continue;
      if (p.locSrc === "place") {
        // 단지명 장소 검색으로 얻은 좌표도 첫 검색어 키로 선적재 (러너에서 V-World 가 막혀도 유지). 1기 신도시는 첫 구성 단지 검색어
        const q = p.complexes?.length
          ? { query: `${p.gu.split(" ")[0]} ${p.complexes[0].core.split("|")[0].trim()}` }
          : placeQueries(p.gu, p.name)[0];
        if (q && !(`PLACE:${q.query}` in geoCache)) {
          geoCache[`PLACE:${q.query}`] = { lng: p.lng, lat: p.lat };
          n++;
        }
        continue;
      }
      if (p.locSrc === "emd") {
        const d = dongsOf(
          p.sido === "서울"
            ? addressCandidates(p.gu, p.jibun).map((address) => ({ address, type: "PARCEL" }))
            : locCandidates(SIDO_FULL[p.sido], p.gu, p.loc),
        )[0];
        if (d && !(`EMD:${d}` in geoCache)) {
          geoCache[`EMD:${d}`] = { lng: p.lng, lat: p.lat };
          n++;
        }
        continue;
      }
      if (p.locSrc !== "geocode") continue;
      const cands =
        p.sido === "서울"
          ? addressCandidates(p.gu, p.jibun).map((address) => ({ address, type: "PARCEL" }))
          : locCandidates(SIDO_FULL[p.sido], p.gu, p.loc);
      if (!cands.length) continue;
      const c = cands[0];
      const ck = c.type === "ROAD" ? `ROAD:${c.address}` : c.address;
      if (!(ck in geoCache)) {
        geoCache[ck] = { lng: p.lng, lat: p.lat };
        n++;
      }
    }
    if (n) console.log(`  이전 자료 좌표 ${n}건을 지오코딩 캐시에 선적재`);
  }

  function geoCacheHit(p) {
    const cands =
      p.sido === "서울"
        ? addressCandidates(p.gu, p.jibun).map((address) => ({ address, type: "PARCEL" }))
        : locCandidates(SIDO_FULL[p.sido], p.gu, p.loc);
    return cands.some((c) => geoCache[c.type === "ROAD" ? `ROAD:${c.address}` : c.address]);
  }
}

/**
 * 이전 public/data 와 비교해 변경 항목을 public/data/changes.json 에 누적한다.
 * - 구역: 도형번호(fid) 기준 신규/삭제, 이름·고시번호 변경
 * - 사업장: 시도|시군구|이름 기준 신규/삭제, 진행단계·사업구분 변경
 * 항목 { ts, type, sido, gu, name, no?, fid?, from?, to? } — 최근 400건, 1년까지 보관
 */
function diffAgainstPrevious(zones, projects, prevZ) {
  const prevP = readJson(path.join(OUT, "projects.json"));
  // 필지 경계(src parcel)는 사업장에 딸린 보조 도형이라 구역 변경 비교에서 뺀다
  const isZone = (f) => f.properties?.src !== "parcel" && f.properties?.src !== "special" && f.properties?.src !== "seoulplan";
  zones = zones.filter(isZone);
  if (prevZ?.features) prevZ = { ...prevZ, features: prevZ.features.filter(isZone) };
  const logPath = path.join(OUT, "changes.json");
  const log = readJson(logPath) ?? { entries: [] };
  const ts = new Date().toISOString();
  const added = [];
  const push = (e) => added.push({ ts, ...e });

  if (Array.isArray(prevP) && prevP.length) {
    const key = (p) => `${p.sido ?? "서울"}|${p.gu}|${normName(p.name)}`;
    const prevMap = new Map(prevP.map((p) => [key(p), p]));
    const curMap = new Map(projects.map((p) => [key(p), p]));
    for (const [k, p] of curMap) {
      const q = prevMap.get(k);
      if (!q) push({ type: "project-new", sido: p.sido, gu: p.gu, name: p.name, no: p.no, to: p.stage, source: p.source });
      else {
        if ((q.stage || "") !== (p.stage || "")) push({ type: "stage-changed", sido: p.sido, gu: p.gu, name: p.name, no: p.no, from: q.stage, to: p.stage });
        if ((q.kind || "") !== (p.kind || "")) push({ type: "kind-changed", sido: p.sido, gu: p.gu, name: p.name, no: p.no, from: q.kind, to: p.kind });
        if (!q.zoneFid && p.zoneFid && p.zoneHow !== "parcel") push({ type: "zone-linked", sido: p.sido, gu: p.gu, name: p.name, no: p.no, fid: p.zoneFid });
      }
    }
    for (const [k, q] of prevMap) if (!curMap.has(k)) push({ type: "project-removed", sido: q.sido, gu: q.gu, name: q.name, from: q.stage });
  }
  if (prevZ?.features?.length) {
    const prevMap = new Map(prevZ.features.map((f) => [f.properties.fid, f.properties]));
    const curMap = new Map(zones.map((f) => [f.properties.fid, f.properties]));
    for (const [fid, z] of curMap) {
      const q = prevMap.get(fid);
      if (!q) push({ type: "zone-new", sido: z.sido, gu: z.gu, name: z.name, fid, to: z.ntfc });
      else if ((q.ntfc || "") !== (z.ntfc || "") || (q.name || "") !== (z.name || ""))
        push({ type: "zone-changed", sido: z.sido, gu: z.gu, name: z.name, fid, from: q.ntfc || q.name, to: z.ntfc || z.name });
    }
    for (const [fid, q] of prevMap) if (!curMap.has(fid)) push({ type: "zone-removed", sido: q.sido, gu: q.gu, name: q.name, fid });
  }
  // 출처 하나에서 신규가 100건을 넘으면(서울플랜+ 첫 반영 등 일괄 추가) 목록을 밀어내지 않게 한 줄로 요약
  const bySrc = {};
  for (const e of added) if (e.type === "project-new" && e.source) (bySrc[e.source] ??= []).push(e);
  for (const [s, arr] of Object.entries(bySrc)) {
    if (arr.length <= 100) continue;
    for (const e of arr) added.splice(added.indexOf(e), 1);
    push({ type: "project-new", sido: arr[0].sido, gu: "", name: `${s} 사업장 ${arr.length.toLocaleString()}건 일괄 추가`, to: "" });
  }
  const linkedAll = added.filter((e) => e.type === "zone-linked");
  if (linkedAll.length > 100) {
    for (const e of linkedAll) added.splice(added.indexOf(e), 1);
    push({ type: "zone-linked", sido: "서울", gu: "", name: `사업장 ${linkedAll.length.toLocaleString()}건에 경계 도형 일괄 연결(서울플랜+)` });
  }
  // 첫 빌드(이전 자료 없음)면 기준선만 기록
  const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 365;
  log.entries = [...added, ...(log.entries ?? [])].filter((e) => new Date(e.ts).getTime() > cutoff).slice(0, 400);
  log.updatedAt = ts;
  log.baseline = log.baseline ?? ts;
  fs.writeFileSync(logPath, JSON.stringify(log));
  const byType = {};
  for (const e of added) byType[e.type] = (byType[e.type] ?? 0) + 1;
  console.log("· 변경 내역", added.length ? byType : "(변경 없음 또는 첫 빌드)");
  return { added: added.length, byType };
}

export function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  사업장 ↔ 구역 연결 검증 규칙 (2026-09-08 압구정 조사 후 전수 점검으로 추가)                */
/*  - 유형 호환: 재건축 사업장은 재건축 구역에만, 재개발은 재개발 구역에만 … (연희1·창전1·신반포1차 등이   */
/*    이름 비슷한 재개발 구역에 묶이던 문제). 지역주택조합·리모델링은 정비구역이 아니므로 좌표·이름으로 안 묶음 */
/*  - 울타리 구역: 재정비촉진지구·존치구역·도시개발구역·주거환경관리 같은 큰 폴리곤은 좌표만으로 안 묶음     */
/*    (전농8구역이 81ha 촉진지구 전체에 묶이던 문제)                                          */
/*  - 숫자 충돌: 이름의 숫자열이 다르면 다른 구역 (영등포1-5~1-18 이 1-12 구역에 몰리던 문제)          */
/* ------------------------------------------------------------------ */
export const UMBRELLA_CODE = /^UQ(51|11)/; // 촉진지구·존치·도시개발
export const MANAGED_CODE = "UQ1212"; // 주거환경관리사업(관리형)
/** 자리표시 관리코드 — 옛 구역 128개가 공유하므로 지도코드 연결에 쓰지 않는다 */
export const PLACEHOLDER_AGZ = "11000AGZ000000001811";

export function kindClass(kind) {
  const k = (kind ?? "").replace(/\([^)]*\)/g, "");
  if (/지역주택|리모델링|모아타운/.test(k)) return "none"; // 모아타운은 관리지역(면)이라 정비구역 폴리곤과 묶지 않는다
  if (/소규모재건축/.test(k)) return "small";
  if (/소규모재개발|가로주택|자율주택/.test(k)) return "small";
  if (/주거환경/.test(k)) return "env";
  if (/재건축/.test(k)) return "rebuild";
  if (/재개발|도시환경|재정비촉진|정비구역지정|후보지/.test(k)) return "redev";
  return "any";
}
/** 사업장 구분과 구역 분류코드가 어울리는가 */
export function compatible(kind, code) {
  const c = kindClass(kind);
  if (c === "none") return false;
  if (c === "any") return true;
  if (/^UQ12(00|90|50)/.test(code)) return true; // 일반 '정비구역' 코드는 무엇이든
  if (c === "rebuild") return code === "UQ1240" || code === "UQ1206";
  if (c === "redev") return /^UQ12(2|3)/.test(code) || UMBRELLA_CODE.test(code);
  if (c === "env") return /^UQ121/.test(code);
  if (c === "small") return /^UQ12(6|7|8)/.test(code);
  return true;
}
/** 두 이름 모두 숫자가 있는데 숫자열이 다르면 다른 구역으로 본다 */
export function digitsConflict(a, b) {
  const da = (a.match(/\d+/g) ?? []).join(","), db = (b.match(/\d+/g) ?? []).join(",");
  return !!da && !!db && da !== db;
}

/* ------------------------------------------------------------------ */
/*  고시 차수별 중복 도형 묶기 (2026-09-08 반포경남 조사)                                              */
/*  의제처리구역 SHP 에는 같은 구역이 최초 고시·변경 고시마다 별도 도형으로 들어 있다(신반포3차·경남 2017/2018,        */
/*  북아현3 은 같은 날 고시 도형 8개 …). 표본점 IoU ≥ 0.7(또는 정규화 이름이 같고 ≥ 0.3)이면 한 그룹으로 보고 최신 고시  */
/*  도형을 대표로, 나머지는 dupOf=대표 fid 로 표시한다. 앱은 대표만 그리고 연결 사업장도 대표로 옮긴다(main).          */
/*  촉진지구·존치 같은 울타리 도형은 촉진구역과 겹치므로 제외. 실측(2026-09-08): 112그룹 136개 숨김, 이름 다른 그룹 42.   */
/* ------------------------------------------------------------------ */
export function bboxOverlapRatio(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const ar = (r) => (r[2] - r[0]) * (r[3] - r[1]);
  return (w * h) / Math.min(ar(a), ar(b));
}
/** 두 도형의 합집합 bbox 에 N×N 표본점을 놓고 포함 여부로 IoU 근사 (라이브러리 없이) */
export function sampledIoU(a, b, N = 40) {
  const ab = a.properties.bbox, bb = b.properties.bbox;
  const x0 = Math.min(ab[0], bb[0]), y0 = Math.min(ab[1], bb[1]), x1 = Math.max(ab[2], bb[2]), y1 = Math.max(ab[3], bb[3]);
  let ia = 0, ib = 0, both = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const pt = [x0 + ((i + 0.5) / N) * (x1 - x0), y0 + ((j + 0.5) / N) * (y1 - y0)];
      const A = pointInGeom(pt, a.geometry), B = pointInGeom(pt, b.geometry);
      if (A) ia++;
      if (B) ib++;
      if (A && B) both++;
    }
  }
  return both / (ia + ib - both || 1);
}
function groupDuplicateZones(zones) {
  const Z = zones.filter((z) => z.properties.src === "seoul" && !UMBRELLA_CODE.test(z.properties.code));
  const parent = new Map(Z.map((z) => [z.properties.fid, z.properties.fid]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (let i = 0; i < Z.length; i++) {
    for (let j = i + 1; j < Z.length; j++) {
      const a = Z[i], b = Z[j];
      if (bboxOverlapRatio(a.properties.bbox, b.properties.bbox) < 0.3) continue;
      const v = sampledIoU(a, b);
      const na = normName(a.properties.name), nb = normName(b.properties.name);
      if (v >= 0.7 || (na.length >= 3 && na === nb && v >= 0.3)) parent.set(find(a.properties.fid), find(b.properties.fid));
    }
  }
  const groups = new Map();
  for (const z of Z) {
    const r = find(z.properties.fid);
    (groups.get(r) ?? groups.set(r, []).get(r)).push(z);
  }
  const dupOf = new Map();
  const ntfcDay = (n) => +((n ?? "").match(/NTC(\d{8})/)?.[1] ?? 0);
  let groupsN = 0, renamed = 0;
  for (const grp of groups.values()) {
    if (grp.length < 2) continue;
    groupsN++;
    grp.sort((a, b) => ntfcDay(b.properties.ntfc) - ntfcDay(a.properties.ntfc) || b.properties.area - a.properties.area || a.properties.fid.localeCompare(b.properties.fid));
    const rep = grp[0];
    // 대표 이름이 "정비구역"·"4구역" 같은 일반명이면 그룹에서 가장 구체적인 이름을 쓴다 (목1 재건축, 세운4구역, 잠실미성크로바)
    if (normName(rep.properties.name).length < 2) {
      const best = [...grp].sort((a, b) => normName(b.properties.name).length - normName(a.properties.name).length)[0];
      if (normName(best.properties.name).length >= 2) {
        rep.properties.name = best.properties.name;
        renamed++;
      }
    }
    rep.properties.dups = grp.slice(1).map((z) => z.properties.ntfc || "");
    for (const z of grp.slice(1)) {
      z.properties.dupOf = rep.properties.fid;
      dupOf.set(z.properties.fid, rep.properties.fid);
    }
  }
  console.log(`· 고시 차수별 중복 도형 ${groupsN}그룹 → ${dupOf.size}개 숨김(dupOf), 대표 이름 보정 ${renamed}`);
  return dupOf;
}

/* ------------------------------------------------------------------ */
/*  통합 전 옛 기록 판별 (2026-09-08 반포경남 조사)                                                    */
/*  정보몽땅에는 통합 재건축 전의 단지별 옛 기록("반포경남아파트 주택재건축", 추진위원회승인)이 지워지지 않고 남아 실제   */
/*  사업("신반포3차,경남", 조합해산)과 따로 있다. 같은 구역 그룹 또는 500 m 안에 완료 기록이 있고 이름이 서로 포함되면      */
/*  (신반포3차,경남 ⊃ 경남) 초기 단계의 옛 기록을 stale=후속 기록 no 로 표시 → 앱은 완공으로 다루고 패널에 안내한다.        */
/*  주의: 신반포4차(조합설립) ↔ 신반포4지구(준공)처럼 숫자만 같은 별개 단지는 잡히면 안 되므로 차·단지·지구는 이름에 남겨    */
/*  비교하고, 법정동 이름(염창동 우성1·2차 ↔ 웅지·오성·"염창")은 공통 토큰으로 인정하지 않는다. 실측(2026-09-08): 서울 1건. */
/* ------------------------------------------------------------------ */
export const EARLY_STAGE = (s) => !/사업시행|사업계획승인|심의|관리처분|착공|철거|분양|이주|준공|이전고시|해산|청산|입주/.test(s ?? "");
export const DONE_STAGE = (s) => /준공|이전고시|해산|청산|입주/.test(s ?? "");
const LIGHT_STRIP =
  /주택재건축정비사업조합설립추진위원회|조합설립추진위원회|조합설립추진위|정비사업조합|정비사업|재건축사업|재개발사업|주택재건축|주택재개발|재정비촉진구역|촉진구역|도시환경정비|도시정비형|주택정비형|공공재개발|공공재건축|재건축|재개발|추진위원회|정비구역|정비계획|정비예정구역|예정구역|조합|아파트|사업|일대|일원|번지|주택|제(?=\d)/g;
const circled = (s) => (s ?? "").replace(/[①-⑳]/g, (c) => String(CIRCLED.indexOf(c) + 1));
export const lightName = (s) => circled(s).replace(LIGHT_STRIP, "").replace(/[\s·ㆍ,\-_.~'’"“”()\[\]]/g, "").toLowerCase();
const nameParts = (s) => circled(s).split(/[,·ㆍ/&+()\[\]]|\s및\s|\s와\s|\s과\s/).map(lightName).filter((t) => t.length >= 2 && /[가-힣]/.test(t));
const dongRootOf = (jibun) => (jibun ?? "").match(/^(\S+?)(동|가|읍|면|리)(\s|$)/)?.[1] ?? "";
export function staleNameRelation(p, q) {
  const fp = lightName(p.name), fq = lightName(q.name);
  if (fp.length < 2 || fq.length < 2 || digitsConflict(fp, fq)) return false;
  if (fp === fq || containsToken(fq, fp) || containsToken(fp, fq)) return true;
  const dongs = [p.jibun, q.jibun].map(dongRootOf).filter(Boolean);
  const isDong = (t) => dongs.some((d) => t.includes(d) || d.includes(t));
  return nameParts(q.name).some((t) => !isDong(t) && (t === fp || containsToken(fp, t))) || nameParts(p.name).some((t) => !isDong(t) && (t === fq || containsToken(fq, t)));
}
function markStaleRecords(projects, dupOf) {
  const groupKey = (fid) => dupOf.get(fid) ?? fid;
  const done = projects.filter((p) => p.source === "정보몽땅" && (DONE_STAGE(p.stage) || p.built || p.doneBy || p.useApr));
  let n = 0;
  for (const p of projects) {
    if (p.stale || p.source !== "정보몽땅" || p.built || p.doneBy || p.useApr || !EARLY_STAGE(p.stage) || kindClass(p.kind) === "none") continue;
    for (const q of done) {
      if (q === p || kindClass(q.kind) !== kindClass(p.kind)) continue;
      const sameGroup = p.zoneFid && q.zoneFid && groupKey(p.zoneFid) === groupKey(q.zoneFid);
      if (!sameGroup && !(p.lat != null && q.lat != null && distKm(p, q) <= 0.5)) continue;
      if (!staleNameRelation(p, q)) continue;
      p.stale = q.no;
      n++;
      console.log(`  옛 기록: ${p.name} [${p.stage}] → ${q.name} [${q.stage}]`);
      break;
    }
  }
  if (n) console.log(`· 통합 전 옛 기록 ${n}건 표시(stale)`);
  return n;
}

/* ------------------------------------------------------------------ */
/*  서울주택정보마당(housinginfo.seoul.go.kr) 관리처분-착공 현황 (2026-09-08 "준공됐는데 진행 중으로 보임" 조사)          */
/*  정보몽땅은 조합이 단계를 갱신하지 않으면 준공 뒤에도 '착공'으로 남고(동작1·개포주공1·장위4·홍은13·신사1·봉천4-1-2),   */
/*  V-World 건물통합정보(LT_C_BLDGINFO)는 수년 늦어(공덕1·개포주공1 자리에 철거된 옛 건물이 그대로) 최근 준공을 못 잡는다.  */
/*  서울시가 반기마다 내는 '착공 중 구역' 목록(착공일자·사업유형·세대수, 60여 곳)과 '이주완료 구역' 목록(29곳)을 받아      */
/*   - 착공 목록에 있으면 cons(착공일·유형·공급세대) → 앱은 관리처분 단계 기록도 착공으로 표시                            */
/*   - 이주완료 목록에 있으면 moved                                                                                  */
/*   - 정보몽땅 단계가 '착공'(도정법 사업)인데 두 목록에 다 없으면 준공 추정 doneBy='정보마당' → 앱은 완공                 */
/*  목록의 절반쯤(중구 도심 도시정비형 등 시행자 방식)은 정보몽땅에 없는 사업이라 매칭 안 되는 목록 행은 그냥 넘긴다.       */
/*  주의: 착공 목록에 남아 있어도 입주가 끝난 곳이 있을 수 있다(준공인가가 입주보다 늦음) — 그런 곳은 건물 판별(built)에 맡김 */
/* ------------------------------------------------------------------ */
const HOUSINGINFO_URL = "https://housinginfo.seoul.go.kr/hmpg/mabu/prst/cons/consDetail.do";
export async function fetchHousingInfo() {
  const cache = path.join(RAW, "housinginfo.json");
  const fresh = fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < 1000 * 60 * 60 * 24 * 7;
  if (fresh && !process.env.FORCE) return JSON.parse(fs.readFileSync(cache, "utf8"));
  try {
    const html = await (await fetch(HOUSINGINFO_URL, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) })).text();
    const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]);
    const rowsOf = (t) =>
      [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()));
    const consT = tables.find((t) => /착공일자/.test(t));
    const movedT = tables.find((t) => {
      const h = rowsOf(t)[0] ?? [];
      return h.length === 3 && h[2] === "구역명";
    });
    const cons = consT
      ? rowsOf(consT).slice(1).filter((r) => r.length >= 4 && /^\d{4}-\d{2}-\d{2}$/.test(r[1])).map((r) => ({ date: r[1], gu: r[2], name: r[3], type: r[5] ?? "", units: r[7] ?? "" }))
      : [];
    const moved = movedT ? rowsOf(movedT).slice(1).filter((r) => r.length >= 3).map((r) => ({ gu: r[1], name: r[2] })) : [];
    if (!cons.length) throw new Error("착공 목록을 찾지 못함");
    const out = { fetchedAt: new Date().toISOString().slice(0, 10), cons, moved };
    fs.writeFileSync(cache, JSON.stringify(out));
    console.log(`· 서울주택정보마당 착공 중 ${cons.length}곳 · 이주완료 ${moved.length}곳`);
    return out;
  } catch (e) {
    console.warn("  서울주택정보마당 실패:", e.message.slice(0, 60));
    return fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, "utf8")) : null;
  }
}
/** 이름 변형들: 괄호 제거 / 괄호를 공백으로(반포아파트(제3주구) → 반포3주구) / 괄호 안 항목 / "문래동진주" → "문래진주" */
export function nameVariants(raw) {
  const inner = raw.match(/\(([^)]*)\)/)?.[1]?.split(/[,·]/) ?? [];
  return [...new Set([raw, raw.replace(/\([^)]*\)/g, ""), raw.replace(/[()]/g, " "), raw.replace(/([가-힣]{2,})동(?=[가-힣])/, "$1"), ...inner].map(normName).filter((v) => v.length >= 2))];
}
/** 정보마당 구역명 ↔ 정보몽땅 사업장(같은 자치구): 가장 잘 맞는 하나. 짧은 쪽이 2글자면 완전 일치만(신반포22차 ⊃ "반포" 같은 오매칭 방지) */
/** 괄호 안 내용만 정규화 ("반포아파트(제3주구)" → "3주구"). normName 은 괄호를 통째로 지우므로 먼저 벗긴다 */
export const innerOf = (raw) => normName((raw.match(/\(([^)]*)\)/g) ?? []).map((s) => s.slice(1, -1)).join(" "));
/** 정보마당 목록 행 ↔ 사업장 하나의 매칭 점수 (0 = 후보 아님). bestHousingMatch 와 explain.mjs 가 함께 쓴다 */
export function housingScore(row, p) {
  if (p.gu !== row.gu) return 0;
  const rv = nameVariants(row.name);
  const ri = innerOf(row.name);
  let s = 0;
  for (const pv of nameVariants(p.name)) {
    for (const v of rv) {
      if (digitsConflict(pv, v)) continue;
      if (pv === v) s = Math.max(s, 1);
      else if (Math.min(pv.length, v.length) >= 3 && (containsToken(pv, v) || containsToken(v, pv))) s = Math.max(s, Math.min(pv.length, v.length) / Math.max(pv.length, v.length));
    }
  }
  if (s < 0.5) return 0;
  // 괄호 안 구분("반포주공1단지(3주구)" ↔ "반포아파트(제3주구)" / "(1,2,4주구)")이 같으면 가산, 숫자가 다르면 감점
  const pi = innerOf(p.name);
  if (ri && pi) s += ri === pi ? 0.5 : digitsConflict(ri, pi) ? -0.5 : 0;
  // 동점이면 완료된 옛 기록보다 진행 기록, 초기 단계보다 후기 단계 기록을 고른다 (연희1 해산/착공, 장미아파트 추진위/착공)
  if (DONE_STAGE(p.stage)) s -= 0.3;
  if (/관리처분|이주|철거|착공|분양/.test(p.stage ?? "")) s += 0.1;
  return s;
}
export function bestHousingMatch(row, projects) {
  let best = null, bestScore = 0;
  for (const p of projects) {
    const s = housingScore(row, p);
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  return best;
}/** 정보몽땅 '착공' 기록이 서울시 착공 중·이주완료 목록에 없으면 준공 추정(doneBy) — 그 조건. explain.mjs 가 이유를 보여준다 */
export function doneByHousingEligible(p) {
  const SMALL = /소규모|가로주택|자율주택|지역주택|리모델링|모아/;
  if (p.source !== "정보몽땅") return { ok: false, reason: "정보몽땅 기록 아님(서울시 목록은 도정법 사업만)" };
  if (p.cons) return { ok: false, reason: "서울시 착공 중 목록에 있음" };
  if (p.moved) return { ok: false, reason: "서울시 이주완료 목록에 있음" };
  if (p.built || p.stale || p.doneBy) return { ok: false, reason: "이미 다른 보정 적용" };
  if (!/착공/.test(p.stage ?? "")) return { ok: false, reason: "원자료 단계가 '착공' 아님('분양'은 조합원 분양신청에도 쓰여 제외)" };
  if (DONE_STAGE(p.stage)) return { ok: false, reason: "원자료가 이미 완료" };
  if (SMALL.test(`${p.kind} ${p.name}`)) return { ok: false, reason: "소규모·가로주택·지역주택·리모델링·모아 (서울시 목록 대상 아님)" };
  return { ok: true, reason: "정보몽땅 '착공'인데 서울시 착공 중·이주완료 목록 어디에도 없음" };
}
function applyHousingInfo(projects, info) {
  if (!info?.cons?.length) return;
  const seoul = projects.filter((p) => p.source === "정보몽땅");
  let cons = 0, moved = 0, done = 0;
  for (const row of info.cons) {
    const p = bestHousingMatch(row, seoul);
    if (p && !p.cons) {
      p.cons = { date: row.date, type: row.type || undefined, units: row.units || undefined };
      cons++;
    }
  }
  for (const row of info.moved ?? []) {
    const p = bestHousingMatch(row, seoul);
    if (p) {
      p.moved = true;
      moved++;
    }
  }
  // '분양'은 조합원 분양신청(착공 전) 단계에도 쓰여 착공 근거가 못 된다 (미아3구역: 분양인데 2027 착공 예정) → '착공'만
  for (const p of seoul) {
    if (!doneByHousingEligible(p).ok) continue;
    p.doneBy = "정보마당";
    done++;
    console.log(`  준공 추정(서울시 착공 목록에 없음): ${p.gu} ${p.name} [${p.stage}]`);
  }
  SOURCE_INFO.housinginfo = info.fetchedAt;
  console.log(`· 정보마당 반영: 착공 ${cons}건, 이주완료 ${moved}건, 준공 추정 ${done}건`);
}

/* ------------------------------------------------------------------ */
/*  건축물대장 총괄표제부(국토부 건축HUB, 공공데이터포털 키 DATA_GO_KR_KEY)로 준공 확정 (2026-09-08)                  */
/*  후기 단계(관리처분~분양) 사업장의 법정동 총괄표제부를 받아, 사용승인일이 착공일(정보마당 cons) 이후·2010년 이후이고    */
/*  세대수가 있는 공동주택 대지의 지번을 지오코딩해 구역 폴리곤 안(폴리곤 없으면 마커 150 m 안)이면 useApr 로 확정한다.    */
/*  정보몽땅 단계 지연·V-World 건물 자료 지연을 모두 건너뛰는 가장 확실한 근거. 총괄표제부는 대지(단지) 단위라 법정동마다     */
/*  수십~수백 행, 한 달 캐시(data/raw/bldrgst.json). 키 없거나 실패하면 이전 projects.json 의 useApr 유지(러너).           */
/* ------------------------------------------------------------------ */
const DATA_GO_KR_KEY = process.env.DATA_GO_KR_KEY ?? "";
const max = (a, b) => (a > b ? a : b);
let zoneByFidGlobal = new Map(); // main() 의 zoneByFid (applyBuildingRegistry 가 폴리곤 포함 판정에 씀)
export const bldrgstCachePath = path.join(RAW, "bldrgst.json");
let bldrgstDown = false;
/** 법정동 코드: 서울은 emdCode, 경기·인천은 위치 문구의 "시군구 (구) 동" 을 lib/bjd-emd.json 에서 찾는다 */
export function emdCodeForProject(p) {
  if (p.emdCode) return p.emdCode;
  if (!EMD) emdCodeOf("", "");
  const loc = p.loc || p.jibun || "";
  const m = loc.match(/(\S+?(?:동\d*가|동|읍|면|가|리))(?=\s|$|\d|,|\))/g);
  if (!m) return null;
  // 행정동(철산2동·주안2동·송림6동)은 숫자를 떼어 법정동(철산동·주안동·송림동)으로도 시도
  const dongs = [...new Set(m.flatMap((d) => [d, d.replace(/(\D)\d+동$/, "$1동")]))];
  const sidoFull = SIDO_FULL[p.sido] ?? "";
  const gu0 = (p.gu ?? "").split(" ")[0];
  // 인천 CSV 는 2026-07 개편 전 구 이름(중구·동구·서구) → 새 이름으로도 시도
  const gus = [...new Set([gu0, ...(SGG_RENAMED[sidoFull]?.[gu0] ?? [])].filter(Boolean))];
  const find = (pred) => EMD.find((line) => {
    const [, full] = line.split("|");
    return full && full.startsWith(sidoFull) && pred(full);
  });
  for (const dong of dongs) for (const gu of gus) {
    const row = find((full) => full.includes(` ${gu}`) && full.endsWith(` ${dong}`));
    if (row) return row.split("|")[0];
  }
  // 시군구가 안 맞으면 시도 안에서 그 동 이름이 하나뿐일 때
  for (const dong of dongs) {
    const rows = EMD.filter((line) => line.split("|")[1]?.startsWith(sidoFull) && line.endsWith(` ${dong}`));
    if (rows.length === 1) return rows[0].split("|")[0];
  }
  return null;
}
export async function fetchRecapTitles(code, cache) {
  const hit = cache.recap[code];
  if (hit && Date.now() - new Date(hit.at).getTime() < 1000 * 60 * 60 * 24 * 30) return hit.rows;
  if (!DATA_GO_KR_KEY || bldrgstDown) return hit?.rows ?? null;
  const rows = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const u = `https://apis.data.go.kr/1613000/BldRgstHubService/getBrRecapTitleInfo?serviceKey=${encodeURIComponent(DATA_GO_KR_KEY)}&sigunguCd=${code.slice(0, 5)}&bjdongCd=${code.slice(5, 10)}&numOfRows=1000&pageNo=${page}&_type=json`;
      const res = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error(text.replace(/\s+/g, " ").slice(0, 80));
      }
      const code2 = j.response?.header?.resultCode;
      if (code2 && code2 !== "00") throw new Error(j.response.header.resultMsg ?? code2);
      let items = j.response?.body?.items?.item;
      items = Array.isArray(items) ? items : items ? [items] : [];
      for (const it of items) rows.push({ plat: String(it.platPlc ?? ""), nm: String(it.bldNm ?? "").trim(), use: String(it.useAprDay ?? ""), hh: +(it.hhldCnt ?? 0), dong: +(it.mainBldCnt ?? 0), pa: +(it.platArea ?? 0), pur: String(it.mainPurpsCdNm ?? "") });
      const total = +(j.response?.body?.totalCount ?? 0);
      if (!items.length || rows.length >= total) break;
      await sleep(100);
    }
    cache.recap[code] = { at: new Date().toISOString().slice(0, 10), rows };
    await sleep(100);
    return rows;
  } catch (e) {
    console.warn("  건축물대장 조회 오류", code, e.message.slice(0, 80));
    if (/SERVICE_KEY|LIMITED|EXCEEDS|폐기/.test(e.message)) bldrgstDown = true;
    return hit?.rows ?? null;
  }
}
/**
 * 사용승인일 하한: 서울시 착공일(cons) 이후, 최근 동향(착공 전 단계 키워드) 날짜 이후, 그리고 2018년 이후
 *  — 구역 안에 원래 있던 2010년대 소형 건물(청량리8 안 중앙애플비 2012 등)을 새 단지로 착각하지 않도록.
 * 자료 단계가 아직 착공 전(관리처분·이주·철거)인데 준공됐다면 단계 갱신이 1~2년 늦은 것 → 2024년 이후 사용승인만 (대광연립 필지 안 2021년 45세대 빌라 제외)
 */
/** 건축물대장 준공 확인 대상인가 (후기 단계, 리모델링·지역주택·모아 제외) */
export function registryEligible(p) {
  if (/리모델링|지역주택|모아/.test(p.kind ?? "")) return { ok: false, reason: "리모델링·지역주택·모아타운은 대상 아님" };
  if (DONE_STAGE(p.stage)) return { ok: false, reason: "원자료가 이미 완료" };
  if (!LATE_STAGE(p.stage)) return { ok: false, reason: "후기 단계(관리처분·이주·철거·착공·분양) 아님" };
  return { ok: true, reason: "후기 단계" };
}
export function registryMinDay(p) {
  let minDay = "20180101";
  const why = ["기본 2018-01-01"];
  const startDay = p.cons?.date ?? p.extra?.find(([k]) => /착공/.test(k))?.[1]?.match(/\d{4}-\d{2}-\d{2}/)?.[0]; // 서울시 착공일 / 경기 추진현황의 착공일
  if (startDay) {
    minDay = max(minDay, startDay.replace(/-/g, ""));
    why.push(`착공일 ${startDay}`);
  }
  if (p.note?.date && /추진위|조합설립|정비구역|사업시행|관리처분|시공사|이주|철거|착공|총회|입찰|공람/.test(p.note.kw ?? "")) {
    minDay = max(minDay, p.note.date.replace(/-/g, ""));
    why.push(`최근 동향 '${p.note.kw}' ${p.note.date}`);
  }
  if (!/착공|분양/.test(p.stage ?? "")) {
    minDay = max(minDay, "20240101");
    why.push("단계가 착공·분양 아님 → 2024-01-01");
  }
  return { minDay, startDay, why };
}
/**
 * 총괄표제부 한 행이 이 사업장의 새 단지인가. ok=false 면 reason 에 어느 조건에서 걸러졌는지.
 * opts.cacheOnly 면 지오코딩 캐시만 본다(explain.mjs, 네트워크 없이)
 */
export async function registryRowCheck(p, z, r, minDay, opts = {}) {
  const SMALL = /소규모|가로주택|자율주택/;
  const minHh = SMALL.test(`${p.kind} ${p.name}`) ? 30 : 50;
  const parcelLike = !!z && (z.properties.src === "parcel" || z.properties.src === "special");
  if (!/^\d{8}$/.test(r.use)) return { ok: false, reason: "사용승인일 없음" };
  if (r.use <= minDay) return { ok: false, reason: `사용승인 ${r.use} ≤ 하한 ${minDay}` };
  if (r.hh < minHh) return { ok: false, reason: `세대 ${r.hh} < ${minHh}` };
  const addr = r.plat.replace(/번지.*$/, "").replace(/\s+외.*$/, "").trim();
  if (!addr) return { ok: false, reason: "대지 지번 없음" };
  // 새 단지의 대지가 구역(또는 자료의 구역면적)의 상당 부분이어야 한다 — 옆 단지·구역 안 소형 건물 제외 (신반포12차 ↔ 옆 신반포르엘, 가락프라자 안 59세대 빌라)
  const refArea = z ? z.properties.area : p.area;
  const ratio = parcelLike ? 0.6 : 0.25;
  if (refArea && r.pa && r.pa < refArea * ratio) return { ok: false, reason: `대지 ${Math.round(r.pa)}㎡ < 구역 ${Math.round(refArea)}㎡ × ${ratio}` };
  if (refArea && !r.pa && r.hh < 200) return { ok: false, reason: "대지면적 없음이고 세대 < 200" };
  const g = opts.cacheOnly ? (geoCache[addr] ?? null) : await geocode(addr, "PARCEL");
  if (!g) return { ok: false, reason: opts.cacheOnly && !(addr in geoCache) ? `지오코딩 캐시 없음 (${addr})` : `지오코딩 실패 (${addr})` };
  let dist = 0;
  if (z) {
    // 지오코딩 점이 경계 바로 밖에 떨어지는 경우(천호3 ↔ 힐데스하임 천호)가 있어 서울시 구역 도형은 경계에서 40 m 까지 허용. 필지·특별계획구역 도형은 안쪽만
    const inPoly = pointInGeom([g.lng, g.lat], z.geometry);
    const dm = inPoly ? 0 : distToGeomM([g.lng, g.lat], z.geometry);
    if (!inPoly && !(!parcelLike && dm <= 40)) return { ok: false, reason: `도형 밖 (경계까지 ${Math.round(dm)} m${parcelLike ? ", 필지·특별계획 도형은 안쪽만" : " > 40 m"})`, g };
  } else {
    // 도형이 없으면 마커에서 150 m 안 — 같은 단지를 여러 기록이 가져가면 applyBuildingRegistry 에서 하나만 남긴다
    dist = p.lat != null ? distKm(g, p) : Infinity;
    if (dist > 0.15) return { ok: false, reason: `마커에서 ${Math.round(dist * 1000)} m > 150 m`, g, dist };
  }
  return { ok: true, reason: "통과", g, dist };
}
async function applyBuildingRegistry(projects) {
  const cache = fs.existsSync(bldrgstCachePath) ? JSON.parse(fs.readFileSync(bldrgstCachePath, "utf8")) : { recap: {} };
  cache.recap ??= {};
  const prev = new Map((readJson(path.join(OUT, "projects.json")) ?? []).filter((p) => p?.useApr).map((p) => [p.no, p.useApr]));
  const cands = projects.filter((p) => registryEligible(p).ok);
  console.log(`· 건축물대장 총괄표제부로 준공 확인: 후기 단계 ${cands.length}건${DATA_GO_KR_KEY ? "" : " (DATA_GO_KR_KEY 없음 → 이전 자료 유지)"}`);
  let confirmed = 0, kept = 0, noCode = 0, i = 0;
  const noZoneHits = [];
  for (const p of cands) {
    if (++i % 50 === 0) {
      process.stdout.write(`  ${i}/${cands.length}\n`);
      fs.writeFileSync(bldrgstCachePath, JSON.stringify(cache));
    }
    const code = emdCodeForProject(p);
    if (!code) {
      noCode++;
      continue;
    }
    const rows = await fetchRecapTitles(code, cache);
    if (!rows) {
      if (prev.has(p.no)) {
        p.useApr = prev.get(p.no);
        kept++;
      }
      continue;
    }
    const z = p.zoneFid ? zoneByFidGlobal.get(p.zoneFid) : null;
    const { minDay, startDay } = registryMinDay(p);
    let best = null;
    for (const r of rows) {
      const v = await registryRowCheck(p, z, r, minDay);
      if (!v.ok) continue;
      if (!best || r.hh > best.hh) best = { ...r, dist: v.dist, started: !!startDay };
    }
    if (best) {
      p.useApr = { date: `${best.use.slice(0, 4)}-${best.use.slice(4, 6)}-${best.use.slice(6, 8)}`, name: best.nm || undefined, units: best.hh, dongs: best.dong || undefined };
      if (!z) noZoneHits.push({ p, key: best.plat, dist: best.dist, started: best.started });
      confirmed++;
    }
  }
  // 도형 없는 기록들이 한 단지를 나눠 가진 경우(파주 금촌2동제2지구 ↔ 옆 율목지구): 착공일이 알려진 기록 > 착공·분양 단계 > 가까운 기록 하나만
  const byKey = new Map();
  for (const h of noZoneHits) (byKey.get(h.key) ?? byKey.set(h.key, []).get(h.key)).push(h);
  for (const hits of byKey.values()) {
    if (hits.length < 2) continue;
    const rank = (h) => (h.started ? 4 : 0) + (/착공|분양/.test(h.p.stage ?? "") ? 2 : 0) - h.dist;
    hits.sort((a, b) => rank(b) - rank(a));
    for (const h of hits.slice(1)) {
      delete h.p.useApr;
      confirmed--;
    }
  }
  fs.writeFileSync(bldrgstCachePath, JSON.stringify(cache));
  if (confirmed || kept) SOURCE_INFO.bldrgst = new Date().toISOString().slice(0, 10);
  console.log(`  사용승인 확인 ${confirmed}건${kept ? `, 이전 자료 유지 ${kept}` : ""}${noCode ? `, 법정동 코드 없음 ${noCode}` : ""}`);
}

export function pickBest(cands, pn, loc) {
  if (cands.length === 1) return cands[0];
  const scored = cands.map((z) => ({
    z,
    s: nameScore(pn, normName(z.properties.name)) - (loc ? distKm(loc, centerOf(z.properties.bbox)) * 0.01 : 0),
  }));
  scored.sort((a, b) => b.s - a.s);
  return scored[0].z;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 법정동 사전(site-law 와 동일 자료) → 읍면동 코드 + PNU */
let EMD = null;
export function emdCodeOf(gu, jibun) {
  if (!EMD) {
    const p = path.join(ROOT, "lib", "bjd-emd.json");
    EMD = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : [];
  }
  // "성수동1가 656" 처럼 동 뒤에 숫자+가 가 붙는 법정동은 통째로 (2026-09-08: 성수동1가·금호동2가·보문동1가 등 7건이 법정동 코드를 못 얻던 문제)
  const m = (jibun ?? "").match(/^(\S+?(?:동\d+가|동|가|읍|면|리))\s*(산)?\s*(\d+)(?:-(\d+))?/);
  if (!m) return null;
  const [, dong, san, bon, bu] = m;
  const full = `서울특별시 ${gu} ${dong}`;
  const row = EMD.find((line) => line.endsWith("|" + full));
  if (!row) return null;
  const code = row.split("|")[0];
  const pnu = code + (san ? "2" : "1") + bon.padStart(4, "0") + (bu ?? "0").padStart(4, "0");
  return { code, pnu };
}

export function centerOf(b) {
  return { lng: +((b[0] + b[2]) / 2).toFixed(6), lat: +((b[1] + b[3]) / 2).toFixed(6) };
}

function loadEnv() {
  for (const f of [".env.local", ".env"]) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

// 직접 실행(node scripts/build-data.mjs)일 때만 빌드. scripts/explain.mjs 등이 import 할 때는 함수만 제공
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
