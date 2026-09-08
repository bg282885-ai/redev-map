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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = path.join(ROOT, "data", "raw");
const OUT = path.join(ROOT, "public", "data");
fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

loadEnv();
/** 출처별 자료 기준 (meta.json 에 기록 → 화면의 "자료 기준" 표시) */
const SOURCE_INFO = { seoulShp: "", cleanup: "", gyeonggi: "", incheon: "" };
const VWORLD_KEY = process.env.VWORLD_API_KEY ?? "";
const VWORLD_DOMAIN = process.env.VWORLD_DOMAIN ?? "localhost";
const UA = "Mozilla/5.0 (compatible; HaenglimRedevMap/1.0)";

/** 서울 자치구 코드 (정보몽땅 signguCode = 법정동 시군구코드 5자리) */
const GU = {
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
function noteFor(p, board) {
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
const geoCache = fs.existsSync(geoCachePath) ? JSON.parse(fs.readFileSync(geoCachePath, "utf8")) : {};
// V-World 는 해외 IP(GitHub Actions 러너 등)에 HTML 차단 페이지를 돌려준다. 연속 실패하면 차단으로 보고
// 남은 지오코딩을 건너뛴다(주소당 15초씩 재시도하면 수천 건에 몇 시간이 걸림). 좌표는 캐시·이전 자료로 유지
let vworldFails = 0;
let vworldDown = false;

async function geocode(address, type = "PARCEL") {
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
function dongsOf(cands) {
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
function placeQueries(gu, name) {
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
function addressCandidates(gu, jibun) {
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
function containsToken(a, b) {
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

function nameScore(a, b) {
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

function bbox(g) {
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
function pointInGeom(pt, g) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  for (const poly of polys) {
    if (!pointInRing(pt, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) if (pointInRing(pt, poly[h])) inHole = true;
    if (!inHole) return true;
  }
  return false;
}

function distKm(a, b) {
  const dx = (a.lng - b.lng) * 88.8, dy = (a.lat - b.lat) * 111;
  return Math.hypot(dx, dy);
}

/* ------------------------------------------------------------------ */
/*  경기·인천 — 사업장 목록(공공데이터포털 CSV) + V-World 지구단위계획 레이어 폴리곤 */
/* ------------------------------------------------------------------ */
const SIDO_FULL = { 서울: "서울특별시", 경기: "경기도", 인천: "인천광역시" };

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
const SGG_RENAMED = { 인천광역시: { 중구: ["제물포구", "영종구"], 동구: ["제물포구"], 서구: ["서해구", "검단구"], 남구: ["미추홀구"] } };

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
function locCandidates(sidoFull, sgg, loc) {
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
async function fetchMoatown() {
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
  const out = [];
  let i = 0;
  for (const [, v] of byLoc) {
    v.notices.sort((a, b) => a.date.localeCompare(b.date));
    const first = v.notices.find((n) => n.kind === "승인") ?? v.notices[0];
    const last = v.notices[v.notices.length - 1];
    const gu = v.gu ?? guOfDong(v.loc.dong);
    if (!gu) continue;
    const stage = last.kind === "공람" && !v.notices.some((n) => n.kind !== "공람") ? "관리계획 공람" : "관리계획 승인(관리지역 지정)";
    out.push({
      no: 11900000 + ++i, sido: "서울", gu, guCode: null, source: "모아타운", kind: "모아타운(소규모주택정비 관리지역)",
      name: `${v.loc.label || v.loc.loc} 모아타운`, jibun: `${v.loc.dong} ${v.loc.bon}`, loc: `서울특별시 ${gu} ${v.loc.loc}`, area: null,
      extra: [["관리계획 승인", first.date], ...(last !== first ? [["최근 고시", `${last.kind} ${last.date}`]] : []), ["고시", last.title.slice(0, 60)]],
      stage, docs: "", cafe: null, map: null,
      note: { date: last.date, kw: `관리계획 ${last.kind}`, title: last.title, url: `https://urban.seoul.go.kr/view/html/PMNU5030110000?noticeCode=${encodeURIComponent(last.code)}`, src: "도시계획포털" },
    });
  }
  // 대상지 현황(아직 승인 전) — data/moatown-sites.json 이 있으면 승인된 곳을 뺀 나머지를 '대상지 선정' 으로
  const sitesPath = path.join(ROOT, "data", "moatown-sites.json");
  let added = 0;
  if (fs.existsSync(sitesPath)) {
    const sites = JSON.parse(fs.readFileSync(sitesPath, "utf8"));
    for (const s of sites.items ?? []) {
      if (!s.dong || !s.bon) continue;
      const loc = { dong: dongLegal(s.dong), bon: String(s.bon), loc: `${s.dongAdm ?? s.dong} ${s.bon}번지 일대` };
      const key = `${loc.dong}|${loc.bon.split("-")[0]}`;
      if (byLoc.has(key)) continue;
      // 같은 동에 승인된 곳이 있고 본번이 비슷하면(±30) 같은 곳으로 본다 — 대상지 표기 지번과 고시 지번이 다를 수 있음
      const near = [...byLoc.keys()].some((k) => k.startsWith(`${loc.dong}|`) && Math.abs(+k.split("|")[1] - +loc.bon.split("-")[0]) <= 30);
      if (near) continue;
      out.push({
        no: 11900000 + ++i, sido: "서울", gu: s.gu, guCode: null, source: "모아타운", kind: "모아타운(소규모주택정비 관리지역)",
        name: `${s.gu} ${loc.loc} 모아타운 대상지`, jibun: `${loc.dong} ${loc.bon}`, loc: `서울특별시 ${s.gu} ${loc.loc}`, area: s.area ?? null,
        extra: [["대상지 선정", s.selected ?? ""], ["출처", sites.source ?? "서울시 모아타운 대상지 현황"]], stage: "대상지 선정", docs: "", cafe: null, map: null,
        note: s.selected ? { date: s.selected, kw: "대상지 선정", src: "국토부·시 발표" } : null,
      });
      added++;
    }
  }
  console.log(`· 모아타운 ${out.length}건 (관리계획 승인 ${out.length - added} + 대상지 ${added}; 도시계획포털 고시 ${list.length}건)`);
  return out;
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
const PARCEL_KIND = /재건축|리모델링/;
const PARCEL_MIN_AREA = (kind) => (/소규모/.test(kind) ? 1500 : 3000);
const parcelCachePath = path.join(RAW, "parcels.json");
let parcelDown = false;

/** 위경도 폴리곤 면적(㎡) — 위도 보정한 평면 근사 (수도권 범위에서 0.1% 이내) */
function areaM2(g) {
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
  if (ck in cache) return cache[ck];
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
        if (/대$/.test(jibun) && area >= PARCEL_MIN_AREA(p.kind)) {
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
const builtCachePath = path.join(RAW, "built.json");
let builtDown = false;

function centroidOf(g) {
  const r = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0];
  let x = 0, y = 0;
  for (const c of r) { x += c[0]; y += c[1]; }
  return [x / r.length, y / r.length];
}

async function fetchBuiltSignal(z, cache) {
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
const LATE_STAGE = (s) => /관리처분|착공|철거|분양|이주/.test(s ?? "") && !/준공|청산|해산|이전고시|입주/.test(s ?? "");

async function markBuiltZones(zones, projects, prevZones) {
  const byFid = new Map();
  for (const p of projects) if (p.zoneFid) (byFid.get(p.zoneFid) ?? byFid.set(p.zoneFid, []).get(p.zoneFid)).push(p);
  const cands = zones.filter((z) => {
    const zp = z.properties;
    if (UMBRELLA_CODE.test(zp.code) || zp.dupOf) return false;
    const linked = byFid.get(zp.fid);
    if (linked) {
      const live = linked.filter((p) => !p.stale && !p.doneBy); // 통합 전 옛 기록·준공 추정 기록은 빼고 본다
      if (!live.length) return false; // 그런 기록만 연결된 구역은 앱에서 이미 완공
      // 연결 사업장이 모두 후기 단계면 준공됐는지 본다 (2026-09-08 확인: 행당7·이문3·방배5·도곡삼호 등 10곳이 단계만 옛 값)
      return live.every((p) => LATE_STAGE(p.stage)) && (zp.area ?? 0) < 300000;
    }
    if (zp.src === "parcel" || zp.src === "special") return false;
    const y = +((zp.ntfc ?? "").match(/NTC(\d{4})/)?.[1] ?? 0);
    return y >= 2010; // 그 이전 고시는 앱에서 이미 '과거 구역'
  });
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
      z.properties.built = tall >= 3 || (tall >= 1 && (z.properties.area ?? 0) < 10000);
      z.properties.builtN = tall;
      if (z.properties.built) built++;
    } else if (prevBuilt.has(z.properties.fid)) {
      z.properties.built = prevBuilt.get(z.properties.fid).built;
      z.properties.builtN = prevBuilt.get(z.properties.fid).builtN;
      if (z.properties.built) built++;
      kept++;
    }
    // 후기 단계 사업장이 연결된 구역이 준공으로 판별되면 그 사업장도 완료로 (앱에서 단계 뒤에 "준공(건물 확인)" 을 붙여 완공으로 분류)
    const linked = (byFid.get(z.properties.fid) ?? []).filter((p) => !p.stale && !p.doneBy);
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
    if (p.complexes) {
      // 1기 신도시 선도지구: 구성 단지마다 장소 검색 → 필지, 전부 합쳐 MultiPolygon (같은 필지는 한 번만)
      const polys = [];
      const seenPnu = new Set();
      let area = 0;
      const found = [];
      for (const c of p.complexes) {
        // 단지 이름 대안("양지5단지 한양|양지마을 한양5단지")과 검색 결과 지점(최대 4곳)을 차례로 → 지목 '대'인 단지 필지가 나올 때까지
        let rr = null;
        outer: for (const alt of c.core.split("|")) {
          for (const pt of await searchPlaceItems(`${p.gu.split(" ")[0]} ${alt.trim()}`, SIDO_FULL[p.sido], p.gu, alt.trim())) {
            const r2 = await fetchParcel({ ...p, pnu: null, lng: pt.lng, lat: pt.lat }, cache);
            if (r2?.geometry) {
              rr = r2;
              break outer;
            }
          }
        }
        if (!rr || (rr.pnu && seenPnu.has(rr.pnu))) continue;
        if (rr.pnu) seenPnu.add(rr.pnu);
        const g = rr.geometry;
        polys.push(...(g.type === "Polygon" ? [g.coordinates] : g.coordinates));
        area += rr.area;
        found.push(c.core.split("|")[0]);
      }
      if (polys.length) r = { geometry: { type: "MultiPolygon", coordinates: polys }, area, addr: `${found.length}/${p.complexes.length} 단지 필지: ${found.join(" · ")}`, pnu: null };
      else r = { skip: "단지 필지 없음" };
    } else r = await fetchParcel(p, cache);
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
  const zones = [...seoulZones, ...extraZones];
  console.log(`  구역 합계 ${zones.length}개 (서울 SHP ${seoulZones.length} + V-World ${extraZones.length})`);
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
  const list = [...seoulList, ...(await collect("경기", "gyeonggi", fetchGyeonggi)), ...(await collect("인천", "incheon", fetchIncheon)), ...fetchNewtown(), ...(await fetchMoatown())];
  if (!list.length) throw new Error("사업장 자료를 하나도 얻지 못함");
  console.log(`· 사업장 ${list.length}건 지오코딩 + 결합`);
  seedGeoCacheFromPrevious();
  const board = await fetchCleanupBoard();

  const projects = [];
  let stat = { geo: 0, place: 0, emd: 0, byMap: 0, byPoint: 0, byName: 0, zoneLoc: 0, none: 0 };
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
    // (a) 정보몽땅 지도 코드 = 결정고시 관리코드 (자리표시 코드는 제외)
    if (p.map && p.map !== PLACEHOLDER_AGZ && byId.has(p.map)) {
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
  /* ---- 통합 전 옛 기록(정보몽땅에 남은 것) 표시 → 앱은 완공으로 ---- */
  markStaleRecords(projects, dupOf);
  /* ---- 서울시 착공 중·이주완료 구역 목록(서울주택정보마당)으로 단계 보정, 목록에 없는 착공·분양 기록은 준공 추정 ---- */
  applyHousingInfo(projects, await fetchHousingInfo());

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
  const isZone = (f) => f.properties?.src !== "parcel" && f.properties?.src !== "special";
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
      if (!q) push({ type: "project-new", sido: p.sido, gu: p.gu, name: p.name, no: p.no, to: p.stage });
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

function readJson(p) {
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
const UMBRELLA_CODE = /^UQ(51|11)/; // 촉진지구·존치·도시개발
const MANAGED_CODE = "UQ1212"; // 주거환경관리사업(관리형)
/** 자리표시 관리코드 — 옛 구역 128개가 공유하므로 지도코드 연결에 쓰지 않는다 */
const PLACEHOLDER_AGZ = "11000AGZ000000001811";

function kindClass(kind) {
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
function compatible(kind, code) {
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
function digitsConflict(a, b) {
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
function bboxOverlapRatio(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const ar = (r) => (r[2] - r[0]) * (r[3] - r[1]);
  return (w * h) / Math.min(ar(a), ar(b));
}
/** 두 도형의 합집합 bbox 에 N×N 표본점을 놓고 포함 여부로 IoU 근사 (라이브러리 없이) */
function sampledIoU(a, b, N = 40) {
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
const EARLY_STAGE = (s) => !/사업시행|사업계획승인|심의|관리처분|착공|철거|분양|이주|준공|이전고시|해산|청산|입주/.test(s ?? "");
const DONE_STAGE = (s) => /준공|이전고시|해산|청산|입주/.test(s ?? "");
const LIGHT_STRIP =
  /주택재건축정비사업조합설립추진위원회|조합설립추진위원회|조합설립추진위|정비사업조합|정비사업|재건축사업|재개발사업|주택재건축|주택재개발|재정비촉진구역|촉진구역|도시환경정비|도시정비형|주택정비형|공공재개발|공공재건축|재건축|재개발|추진위원회|정비구역|정비계획|정비예정구역|예정구역|조합|아파트|사업|일대|일원|번지|주택|제(?=\d)/g;
const circled = (s) => (s ?? "").replace(/[①-⑳]/g, (c) => String(CIRCLED.indexOf(c) + 1));
const lightName = (s) => circled(s).replace(LIGHT_STRIP, "").replace(/[\s·ㆍ,\-_.~'’"“”()\[\]]/g, "").toLowerCase();
const nameParts = (s) => circled(s).split(/[,·ㆍ/&+()\[\]]|\s및\s|\s와\s|\s과\s/).map(lightName).filter((t) => t.length >= 2 && /[가-힣]/.test(t));
const dongRootOf = (jibun) => (jibun ?? "").match(/^(\S+?)(동|가|읍|면|리)(\s|$)/)?.[1] ?? "";
function staleNameRelation(p, q) {
  const fp = lightName(p.name), fq = lightName(q.name);
  if (fp.length < 2 || fq.length < 2 || digitsConflict(fp, fq)) return false;
  if (fp === fq || containsToken(fq, fp) || containsToken(fp, fq)) return true;
  const dongs = [p.jibun, q.jibun].map(dongRootOf).filter(Boolean);
  const isDong = (t) => dongs.some((d) => t.includes(d) || d.includes(t));
  return nameParts(q.name).some((t) => !isDong(t) && (t === fp || containsToken(fp, t))) || nameParts(p.name).some((t) => !isDong(t) && (t === fq || containsToken(fq, t)));
}
function markStaleRecords(projects, dupOf) {
  const groupKey = (fid) => dupOf.get(fid) ?? fid;
  const done = projects.filter((p) => p.source === "정보몽땅" && (DONE_STAGE(p.stage) || p.built || p.doneBy));
  let n = 0;
  for (const p of projects) {
    if (p.stale || p.source !== "정보몽땅" || p.built || p.doneBy || !EARLY_STAGE(p.stage) || kindClass(p.kind) === "none") continue;
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
async function fetchHousingInfo() {
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
function nameVariants(raw) {
  const inner = raw.match(/\(([^)]*)\)/)?.[1]?.split(/[,·]/) ?? [];
  return [...new Set([raw, raw.replace(/\([^)]*\)/g, ""), raw.replace(/[()]/g, " "), raw.replace(/([가-힣]{2,})동(?=[가-힣])/, "$1"), ...inner].map(normName).filter((v) => v.length >= 2))];
}
/** 정보마당 구역명 ↔ 정보몽땅 사업장(같은 자치구): 가장 잘 맞는 하나. 짧은 쪽이 2글자면 완전 일치만(신반포22차 ⊃ "반포" 같은 오매칭 방지) */
/** 괄호 안 내용만 정규화 ("반포아파트(제3주구)" → "3주구"). normName 은 괄호를 통째로 지우므로 먼저 벗긴다 */
const innerOf = (raw) => normName((raw.match(/\(([^)]*)\)/g) ?? []).map((s) => s.slice(1, -1)).join(" "));
function bestHousingMatch(row, projects) {
  const rv = nameVariants(row.name);
  const ri = innerOf(row.name);
  let best = null, bestScore = 0;
  for (const p of projects) {
    if (p.gu !== row.gu) continue;
    let s = 0;
    for (const pv of nameVariants(p.name)) {
      for (const v of rv) {
        if (digitsConflict(pv, v)) continue;
        if (pv === v) s = Math.max(s, 1);
        else if (Math.min(pv.length, v.length) >= 3 && (containsToken(pv, v) || containsToken(v, pv))) s = Math.max(s, Math.min(pv.length, v.length) / Math.max(pv.length, v.length));
      }
    }
    if (s < 0.5) continue;
    // 괄호 안 구분("반포주공1단지(3주구)" ↔ "반포아파트(제3주구)" / "(1,2,4주구)")이 같으면 가산, 숫자가 다르면 감점
    const pi = innerOf(p.name);
    if (ri && pi) s += ri === pi ? 0.5 : digitsConflict(ri, pi) ? -0.5 : 0;
    // 동점이면 완료된 옛 기록보다 진행 기록, 초기 단계보다 후기 단계 기록을 고른다 (연희1 해산/착공, 장미아파트 추진위/착공)
    if (DONE_STAGE(p.stage)) s -= 0.3;
    if (/관리처분|이주|철거|착공|분양/.test(p.stage ?? "")) s += 0.1;
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  return best;
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
  const SMALL = /소규모|가로주택|자율주택|지역주택|리모델링|모아/;
  for (const p of seoul) {
    if (p.cons || p.moved || p.built || p.stale || p.doneBy) continue;
    if (!/착공/.test(p.stage ?? "") || DONE_STAGE(p.stage) || SMALL.test(`${p.kind} ${p.name}`)) continue;
    p.doneBy = "정보마당";
    done++;
    console.log(`  준공 추정(서울시 착공 목록에 없음): ${p.gu} ${p.name} [${p.stage}]`);
  }
  SOURCE_INFO.housinginfo = info.fetchedAt;
  console.log(`· 정보마당 반영: 착공 ${cons}건, 이주완료 ${moved}건, 준공 추정 ${done}건`);
}

function pickBest(cands, pn, loc) {
  if (cands.length === 1) return cands[0];
  const scored = cands.map((z) => ({
    z,
    s: nameScore(pn, normName(z.properties.name)) - (loc ? distKm(loc, centerOf(z.properties.bbox)) * 0.01 : 0),
  }));
  scored.sort((a, b) => b.s - a.s);
  return scored[0].z;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 법정동 사전(site-law 와 동일 자료) → 읍면동 코드 + PNU */
let EMD = null;
function emdCodeOf(gu, jibun) {
  if (!EMD) {
    const p = path.join(ROOT, "lib", "bjd-emd.json");
    EMD = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : [];
  }
  const m = (jibun ?? "").match(/^(\S+?(?:동|가|읍|면|리))\s*(산)?\s*(\d+)(?:-(\d+))?/);
  if (!m) return null;
  const [, dong, san, bon, bu] = m;
  const full = `서울특별시 ${gu} ${dong}`;
  const row = EMD.find((line) => line.endsWith("|" + full));
  if (!row) return null;
  const code = row.split("|")[0];
  const pnu = code + (san ? "2" : "1") + bon.padStart(4, "0") + (bu ?? "0").padStart(4, "0");
  return { code, pnu };
}

function centerOf(b) {
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
