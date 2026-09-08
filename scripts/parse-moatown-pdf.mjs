// scripts/parse-moatown-pdf.mjs — 서울시 「모아타운(소규모주택정비 관리지역) 대상지 현황」 PDF 의 텍스트(PyMuPDF 로 뽑은 .txt)를
// data/moatown-sites.json 으로 바꾼다. 표 열: 연번 · 자치구 · 대표지번 · 면적(㎡) · 권리산정기준일 · 비고.
// 사용: node scripts/parse-moatown-pdf.mjs <pdf-text.txt> [기준일 YYYY-MM-DD] [출처 설명]
import fs from "node:fs";
import path from "node:path";

const [, , txtPath, asOf = "", source = "서울시 모아타운 대상지 현황"] = process.argv;
if (!txtPath) {
  console.error("사용: node scripts/parse-moatown-pdf.mjs <text.txt> [기준일] [출처]");
  process.exit(1);
}
const lines = fs.readFileSync(txtPath, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

const isNo = (s) => /^\d{1,3}$/.test(s);
const isGu = (s) => /^[가-힣]+구$/.test(s);
const isArea = (s) => /^\d{1,3}(,\d{3})*$/.test(s);
const dateRe = /[’']?(\d{2})\.(\d{1,2})\.(\d{1,2})/g;

const items = [];
for (let i = 0; i < lines.length; i++) {
  if (!(isNo(lines[i]) && isGu(lines[i + 1] ?? ""))) continue;
  const gu = lines[i + 1];
  const jibunRaw = lines[i + 2] ?? "";
  // 면적 줄 찾기 (대표지번이 두 줄로 나뉠 수도 있음)
  let k = i + 3;
  let jibun = jibunRaw;
  while (k < lines.length && !isArea(lines[k]) && k < i + 5) jibun += lines[k++];
  const area = isArea(lines[k] ?? "") ? +lines[k].replace(/,/g, "") : null;
  // 다음 레코드 시작 전까지: 날짜·비고
  let j = k + 1;
  const rest = [];
  while (j < lines.length && !(isNo(lines[j]) && isGu(lines[j + 1] ?? ""))) rest.push(lines[j++]);
  const dates = [...rest.join(" ").matchAll(dateRe)].map((m) => `20${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`).sort();
  const dateTest = /[’']?\d{2}\.\d{1,2}\.\d{1,2}/; // g 플래그 없는 판정용 (test 는 lastIndex 에 영향받음)
  const remark = rest.filter((s) => !dateTest.test(s) && !/^\d\)$/.test(s) && !/개별조합/.test(s)).join(" ").replace(/\s+/g, " ").trim();
  // "면목3·8동44-6" → 행정동 "면목3·8동", 법정동 "면목동", 본번 "44-6"
  const m = jibun.match(/^([가-힣0-9·]+?(?:동|가))\s*(\d+(?:-\d+)?)/);
  if (!m) {
    console.warn("지번 해석 실패:", jibun);
    i = j - 1;
    continue;
  }
  const dongAdm = m[1];
  const dong = dongAdm.replace(/(본|\d+(?:·\d+)*)동$/, "동");
  items.push({ gu, dongAdm, dong, bon: m[2], area, selected: dates[0] ?? null, remark: remark || null });
  i = j - 1;
}
const out = { _note: "서울시 모아타운(소규모주택정비 관리지역) 대상지 현황 PDF 를 scripts/parse-moatown-pdf.mjs 로 옮긴 것. 도시계획포털에 관리계획 승인 고시가 있는 곳은 빌드 때 그 고시가 우선한다. 새 대상지 공모 결과가 나오면 items 에 추가.", asOf, source, items };
const dst = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "data", "moatown-sites.json");
fs.writeFileSync(dst, JSON.stringify(out, null, 1));
console.log(`${items.length}건 → ${dst}`);
for (const it of items.slice(0, 8)) console.log(" ", JSON.stringify(it));
