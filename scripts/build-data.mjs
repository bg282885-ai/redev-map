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
async function latestShpInfo() {
  try {
    const html = await (await fetch("https://data.seoul.go.kr/dataList/OA-20957/F/1/datasetView.do", { headers: { "User-Agent": UA } })).text();
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
  console.log("· SHP → GeoJSON 변환 (EPSG:5174 → WGS84, 10% 단순화)");
  const tmp = path.join(RAW, "zones_raw.geojson");
  const q = (s) => `"${s.replace(/\\/g, "/")}"`;
  await mapshaper.runCommands(
    `-i ${q(shp)} encoding=euc-kr -filter "/^UQ(11|12|51)/.test(ATRB_SE)" ` +
      `-proj from="${SHP_PROJ}" crs=wgs84 -simplify 10% keep-shapes ` +
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
async function fetchCleanupList() {
  const cache = path.join(RAW, "cleanup-list.json");
  const maxAge = 1000 * 60 * 60 * 24 * 3;
  if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < maxAge && !process.env.FORCE) {
    SOURCE_INFO.cleanup = new Date(fs.statSync(cache).mtimeMs).toISOString().slice(0, 10);
    return JSON.parse(fs.readFileSync(cache, "utf8"));
  }
  SOURCE_INFO.cleanup = new Date().toISOString().slice(0, 10);
  console.log("· 정보몽땅 사업장 목록 수집 (자치구 25개)");
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

async function geocode(address, type = "PARCEL") {
  const ck = type === "ROAD" ? `ROAD:${address}` : address;
  if (ck in geoCache) return geoCache[ck];
  if (!VWORLD_KEY) return null;
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
      await sleep(70); // 연속 호출 시 차단 방지
      return v;
    } catch (e) {
      // 잠시 차단되면 HTML 이 오거나 fetch 가 실패한다 → 쉬었다가 재시도
      if (attempt === 3) console.warn("  지오코딩 오류", address, e.message);
      await sleep(2500 * attempt);
    }
  }
  return null;
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

export function normName(s) {
  return (s ?? "")
    .replace(/\([^)]*\)/g, " ")
    .replace(STRIP, "")
    .replace(/[\s·ㆍ,\-_.~'’"“”]/g, "")
    .toLowerCase();
}

/** a 가 b 를 포함하는가 (b 끝이 숫자면 뒤에 숫자가 이어지지 않아야 함: 장위1 ≠ 장위13) */
function containsToken(a, b) {
  if (b.length < 2 || a.length < b.length) return false;
  let i = a.indexOf(b);
  while (i >= 0) {
    const next = a[i + b.length];
    const prev = a[i - 1];
    const digitTail = /\d/.test(b[b.length - 1]);
    const digitHead = /\d/.test(b[0]);
    if (!(digitTail && next && /\d/.test(next)) && !(digitHead && prev && /\d/.test(prev))) return true;
    i = a.indexOf(b, i + 1);
  }
  return false;
}

function nameScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
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
async function main() {
  const shp = await downloadShp();
  const seoulZones = await buildZones(shp);
  for (const z of seoulZones) {
    z.properties.sido = "서울";
    z.properties.src = "seoul";
  }
  const extraZones = await fetchVworldZones();
  const zones = [...seoulZones, ...extraZones];
  fs.writeFileSync(path.join(OUT, "zones.geojson"), JSON.stringify({ type: "FeatureCollection", features: zones }));
  console.log(`  구역 합계 ${zones.length}개, ${(fs.statSync(path.join(OUT, "zones.geojson")).size / 1e6).toFixed(2)} MB`);
  const byId = new Map();
  for (const z of zones) {
    if (!byId.has(z.properties.id)) byId.set(z.properties.id, []);
    byId.get(z.properties.id).push(z);
  }
  const zoneNorm = zones.map((z) => ({ z, n: normName(z.properties.name), c: centerOf(z.properties.bbox) }));

  const seoulList = (await fetchCleanupList()).map((p) => ({ ...p, sido: "서울", source: "정보몽땅" }));
  const list = [...seoulList, ...(await fetchGyeonggi()), ...(await fetchIncheon())];
  console.log(`· 사업장 ${list.length}건 지오코딩 + 결합`);

  const projects = [];
  let stat = { geo: 0, byMap: 0, byPoint: 0, byName: 0, zoneLoc: 0, none: 0 };
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
    const pn = normName(p.name);

    let zone = null, how = null;
    // (a) 정보몽땅 지도 코드 = 결정고시 관리코드
    if (p.map && byId.has(p.map)) {
      zone = pickBest(byId.get(p.map), pn, loc);
      how = "map";
      stat.byMap++;
    }
    // (b) 대표지번 좌표가 들어있는 구역 (이름 유사도로 우선순위) — 같은 시도 안에서만
    if (!zone && loc) {
      const pt = [loc.lng, loc.lat];
      const hits = zones.filter((z) => {
        if ((z.properties.sido ?? "서울") !== (p.sido ?? "서울")) return false;
        const b = z.properties.bbox;
        return pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3] && pointInGeom(pt, z.geometry);
      });
      if (hits.length) {
        zone = pickBest(hits, pn, loc);
        how = "point";
        stat.byPoint++;
      }
    }
    // (c) 이름 매칭 (좌표가 있으면 3km 이내, 없으면 서울 전체에서 유일할 때만)
    if (!zone && pn.length >= 3) {
      const cands = zoneNorm
        .filter((x) => (x.z.properties.sido ?? "서울") === (p.sido ?? "서울"))
        .map((x) => ({ ...x, s: nameScore(pn, x.n) }))
        .filter((x) => x.s >= 0.5 && (!loc || distKm(loc, x.c) <= 3));
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
      jibun: p.jibun || (p.loc ? p.loc.replace(/\s*일원|\s*일대/g, "").slice(0, 40) : ""),
      loc: p.loc ?? "",
      area: p.area ?? null,
      extra: p.extra ?? undefined,
      stage: p.stage,
      docs: p.docs,
      cafe: p.cafe,
      map: p.map,
      lat: loc?.lat ?? null,
      lng: loc?.lng ?? null,
      locSrc: loc ? (how && !geoCacheHit(p) ? "zone" : "geocode") : null,
      zoneId: zone?.properties.id ?? null,
      zoneFid: zone?.properties.fid ?? null,
      zoneHow: how,
    });
  }
  fs.writeFileSync(geoCachePath, JSON.stringify(geoCache));

  /* ---- 이전 자료와 비교해 변경 내역(신규 구역·사업장, 단계 변경) 기록 ---- */
  const changes = diffAgainstPrevious(zones, projects);

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
function diffAgainstPrevious(zones, projects) {
  const prevP = readJson(path.join(OUT, "projects.json"));
  const prevZ = readJson(path.join(OUT, "zones.geojson"));
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
        if (!q.zoneFid && p.zoneFid) push({ type: "zone-linked", sido: p.sido, gu: p.gu, name: p.name, no: p.no, fid: p.zoneFid });
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
