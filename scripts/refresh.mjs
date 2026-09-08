/**
 * 1시간마다 자료를 다시 받아 지도 데이터를 재확인·갱신한다 (사무실 PC 작업 스케줄러 「HAENGLIM 정비사업 지도 자동 갱신」).
 *
 *  1. origin/main 이 앞서 있으면(주간 GitHub 러너 커밋 등) fast-forward 로 받는다.
 *  2. REFRESH_MODE=hourly 로 build-data.mjs 실행 — 정보몽땅 목록·고시 게시판, 지자체 포털(서초·광명·온누리), 서울시 착공 현황은 매번,
 *     서울플랜+는 6시간, 경기 시트·인천 CSV는 하루 간격으로 새로 받는다(캐시 수명은 build-data.mjs TTL). 지오코딩·필지·건물 판별 캐시는 그대로.
 *     빌드가 이전 public/data 와 비교해 changes.json 에 변경(신규 사업장·단계 변경→준공, 구역 신규·연결 등)을 쌓고, 앱의 종 버튼이 그것을 보인다.
 *  3. projects/zones/changes 가 실제로 바뀌었을 때만 커밋·push → Vercel 자동 배포. 시각만 바뀐 meta.json 은 되돌려 빈 커밋을 만들지 않는다.
 *  4. data/raw/refresh.log 에 요약 한 줄, data/raw/refresh-status.json 에 마지막 실행 결과, data/raw/refresh-build.log 에 마지막 빌드 출력.
 *
 *  잠금: data/raw/refresh.lock 이 50분 안에 만들어진 것이면 겹쳐 돌지 않는다. 수동 실행: `npm run refresh` (환경변수 REFRESH_MODE 를 안 주면 기본 캐시 수명).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = path.join(ROOT, "data", "raw");
const LOG = path.join(RAW, "refresh.log");
const BUILD_LOG = path.join(RAW, "refresh-build.log");
const LOCK = path.join(RAW, "refresh.lock");
const STATUS = path.join(RAW, "refresh-status.json");
const DATA_FILES = ["public/data/projects.json", "public/data/zones.geojson", "public/data/changes.json"];
fs.mkdirSync(RAW, { recursive: true });

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
function log(s) {
  const line = `[${ts()}] ${s}`;
  console.log(line);
  fs.appendFileSync(LOG, line + "\n");
}
function git(...args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
function writeStatus(obj) {
  fs.writeFileSync(STATUS, JSON.stringify({ lastRun: new Date().toISOString(), ...obj }, null, 1));
}

// 로그가 2 MB 를 넘으면 한 번 회전
if (fs.existsSync(LOG) && fs.statSync(LOG).size > 2e6) fs.renameSync(LOG, LOG + ".1");

// 잠금
if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 50 * 60e3) {
  log(`이미 실행 중(잠금 ${LOCK}) → 건너뜀`);
  process.exit(0);
}
fs.writeFileSync(LOCK, String(process.pid));
const t0 = Date.now();
try {
  // 1. 원격 최신 받기 (fast-forward 만)
  let canPush = true;
  const fetched = git("fetch", "origin", "main");
  if (!fetched.ok) log(`git fetch 실패(오프라인?): ${fetched.err.split("\n")[0]}`);
  else {
    const behind = +git("rev-list", "--count", "HEAD..origin/main").out || 0;
    const ahead = +git("rev-list", "--count", "origin/main..HEAD").out || 0;
    if (behind && !ahead) {
      const m = git("merge", "--ff-only", "origin/main");
      log(m.ok ? `origin/main ${behind}개 커밋 받음` : `fast-forward 실패(작업 중 변경과 충돌?): ${m.err.split("\n")[0]} → 이번엔 push 하지 않음`);
      if (!m.ok) canPush = false;
    } else if (behind && ahead) {
      log(`로컬과 원격이 갈라짐(앞 ${ahead}·뒤 ${behind}) → 빌드는 하되 커밋·push 는 건너뜀 (사람이 정리 필요)`);
      canPush = false;
    }
  }

  // 2. 빌드
  const env = { ...process.env, REFRESH_MODE: process.env.REFRESH_MODE ?? "hourly" };
  const b = spawnSync(process.execPath, [path.join(ROOT, "scripts", "build-data.mjs")], { cwd: ROOT, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024, timeout: 45 * 60e3 });
  const out = `${b.stdout ?? ""}\n${b.stderr ?? ""}`;
  fs.writeFileSync(BUILD_LOG, out);
  if (b.status !== 0) {
    const tail = out.trim().split("\n").slice(-3).join(" | ");
    log(`빌드 실패(exit ${b.status}) — ${tail}`);
    writeStatus({ ok: false, error: tail, durationSec: Math.round((Date.now() - t0) / 1000) });
    process.exit(1);
  }
  const changeLine = out.match(/· 변경 내역 ([^\n]*)/)?.[1]?.trim() ?? "";
  const summary = /변경 없음/.test(changeLine) || !changeLine ? "변경 없음" : changeLine.replace(/[{}']/g, "").replace(/\s+/g, " ").trim();

  // 3. 실제 자료가 바뀌었을 때만 커밋·push
  const changedFiles = git("status", "--porcelain", "--", "public/data").out.split("\n").filter(Boolean).map((l) => l.slice(3).trim());
  const dataChanged = changedFiles.some((f) => DATA_FILES.includes(f));
  let commit = "", pushed = false;
  if (!dataChanged) {
    if (changedFiles.includes("public/data/meta.json")) git("checkout", "--", "public/data/meta.json");
    log(`확인 완료 — ${summary} (${Math.round((Date.now() - t0) / 1000)}s)`);
  } else {
    git("add", "--", "public/data");
    const when = new Date();
    const stamp = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
    const c = spawnSync("git", ["-c", "core.safecrlf=false", "commit", "-q", "-m", `data: 자동 갱신 ${stamp} — ${summary}`], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
    if (c.status !== 0) log(`커밋 실패: ${(c.stderr ?? "").trim().split("\n")[0]}`);
    else {
      commit = git("rev-parse", "--short", "HEAD").out;
      if (canPush) {
        const p = git("push", "-q", "origin", "main");
        pushed = p.ok;
        log(`${pushed ? "커밋·push" : "커밋(push 실패: " + p.err.split("\n")[0] + ")"} ${commit} — ${summary} (${Math.round((Date.now() - t0) / 1000)}s)`);
      } else log(`커밋 ${commit}(push 보류) — ${summary}`);
    }
  }
  writeStatus({ ok: true, changed: dataChanged, summary, commit, pushed, durationSec: Math.round((Date.now() - t0) / 1000) });
} catch (e) {
  log(`오류: ${e.message}`);
  writeStatus({ ok: false, error: e.message, durationSec: Math.round((Date.now() - t0) / 1000) });
  process.exitCode = 1;
} finally {
  if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK);
}
