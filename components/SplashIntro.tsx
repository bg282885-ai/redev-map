"use client";

import { useEffect, useState } from "react";

/**
 * 첫 진입 브랜드 인트로 — 지도 연출.
 * 1) 실제 정비구역 세 곳(한남3·흑석9·노량진1)의 경계선이 펜으로 그리듯 그어지고 유형색으로 채워진다
 * 2) 진행단계 색 마커가 톡톡 찍힌다
 * 3) 지도 조각이 뒤로 물러나며 HAENGLIM 워드마크가 글자별로 떠오른다
 * 4) 밑줄이 그어지고 "정비사업 지도"·"도시정비사업본부"가 자간을 좁히며 모인다
 * - public/splash-init.js 가 sessionStorage 를 보고 <html class="hl-splash"> 를 미리 붙여 깜빡임 없이 표시
 * - 끝나면(또는 클릭하면) 걷히고, 같은 세션에서는 다시 나오지 않음. prefers-reduced-motion 이면 생략
 */
export const SPLASH_KEY = "rm_splash_seen";
const HOLD_MS = 3900;
const FADE_MS = 650;

/* 실제 구역 경계 (public/data/zones.geojson 에서 뽑아 0~100 상자에 맞춘 것) */
const SHAPES: { name: string; d: string; color: string; left: number; top: number; width: number; rot: number }[] = [
  {
    name: "한남3 재정비촉진구역",
    color: "#E5484D",
    left: 4, top: 6, width: 44, rot: -6,
    d: "M2.8,16.8L4.6,20.2L2.5,28.7L5.3,33.5L8.8,36.6L12.8,37.6L16.5,38.9L20.0,39.8L23.7,41.2L25.5,44.1L26.4,44.3L29.8,46.5L35.5,49.8L34.9,50.8L29.2,56.4L24.0,57.9L22.5,60.6L18.6,58.8L13.9,56.3L10.4,61.7L10.0,72.3L36.7,99.6L51.7,89.8L61.5,92.3L51.8,77.2L54.9,69.6L65.9,64.3L73.2,77.7L75.1,82.7L77.8,74.5L87.6,69.0L88.9,65.0L89.1,59.6L89.0,54.6L84.2,46.9L81.8,42.6L77.7,34.1L77.3,30.3L72.9,21.3L61.6,21.2L55.2,23.9L47.4,25.5L41.1,24.2L36.7,24.0L32.5,23.6L31.5,15.7L34.0,14.1L31.5,8.4L29.9,6.2L25.3,0.0L21.1,3.6L15.0,7.9L6.8,5.1L1.3,2.4L4.0,11.9L2.8,16.8Z",
  },
  {
    name: "흑석9재정비촉진구역",
    color: "#2F6FED",
    left: 50, top: 2, width: 32, rot: 8,
    d: "M38.1,16.8L21.6,4.2L21.2,0.8L11.6,22.4L9.6,27.4L8.4,31.4L4.4,49.8L3.9,67.3L4.6,75.9L2.1,94.9L0.8,96.4L7.9,96.4L8.3,96.4L10.7,97.6L10.3,100.0L15.1,96.5L15.8,96.2L15.8,96.2L16.4,96.0L17.3,95.8L18.2,95.5L19.1,95.3L20.0,95.0L21.0,94.9L21.9,94.7L23.3,94.5L24.3,94.4L24.8,94.3L27.1,94.2L29.5,94.2L32.1,96.2L40.5,94.3L53.1,95.5L64.7,95.6L68.9,95.1L69.5,94.4L69.3,94.1L69.5,92.8L71.5,91.8L73.0,92.6L79.4,90.4L83.8,85.9L89.7,65.8L85.6,61.0L82.4,58.1L80.5,55.1L73.2,53.1L73.2,51.6L73.4,48.7L71.9,45.5L67.3,41.9L56.7,10.5L39.2,8.5Z",
  },
  {
    name: "노량진1재정비촉진구역",
    color: "#2AA36B",
    left: 58, top: 46, width: 34, rot: -3,
    d: "M65.1,98.8L67.1,98.7L67.8,76.5L86.5,76.5L87.8,2.9L86.9,2.9L86.0,2.8L84.7,2.8L81.9,2.7L76.4,2.5L68.4,2.2L67.2,0.6L8.5,0.0L8.3,6.7L8.1,11.2L7.2,18.2L7.1,18.8L5.3,28.7L1.7,48.8L1.7,49.0L1.1,51.9L0.6,55.1L0.2,58.4L0.0,63.2L0.1,67.4L0.6,71.1L1.1,74.3L1.3,75.4L0.3,75.4L4.9,88.4L5.2,88.9L9.4,90.1L9.7,91.2L16.1,93.1L21.7,95.2L26.1,98.1L29.3,98.4L32.5,99.3L35.7,100.0L47.7,99.0L49.8,99.1L53.6,99.2L63.9,98.9L65.1,98.8Z",
  },
];

/* 진행단계 색 마커 (지도 조각 안의 % 위치) */
const DOTS: { left: number; top: number; color: string }[] = [
  { left: 22, top: 34, color: "#EC6C1E" },
  { left: 33, top: 58, color: "#E5484D" },
  { left: 62, top: 20, color: "#8B5CF6" },
  { left: 70, top: 66, color: "#2AA36B" },
  { left: 84, top: 40, color: "#2F6FED" },
  { left: 14, top: 70, color: "#F59E0B" },
  { left: 46, top: 44, color: "#9CA3AF" },
];

const BRAND = ["H", "Λ", "E", "N", "G", "L", "I", "M"];

function Lambda() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" style={{ height: "0.72em", width: "0.76em", display: "inline-block", verticalAlign: "baseline" }}>
      <polygon points="0,100 38.5,0 61.5,0 100,100 77,100 50,27 23,100" fill="currentColor" />
    </svg>
  );
}

export function SplashIntro() {
  const [phase, setPhase] = useState<"idle" | "out" | "done">("idle");

  useEffect(() => {
    if (!document.documentElement.classList.contains("hl-splash")) return;
    try {
      sessionStorage.setItem(SPLASH_KEY, "1");
    } catch {}
    const t1 = window.setTimeout(() => setPhase("out"), HOLD_MS);
    return () => window.clearTimeout(t1);
  }, []);

  useEffect(() => {
    if (phase !== "out") return;
    const t = window.setTimeout(() => {
      document.documentElement.classList.remove("hl-splash");
      setPhase("done");
    }, FADE_MS);
    return () => window.clearTimeout(t);
  }, [phase]);

  if (phase === "done") return null;

  return (
    <div className={`splash ${phase === "out" ? "splash-out" : ""}`} role="presentation" aria-hidden="true" onClick={() => setPhase("out")} title="클릭하면 건너뜁니다">
      <div className="splash-stage">
        {/* 1)·2) 지도 조각: 구역 경계 + 마커 */}
        <div className="splash-map">
          <div className="splash-grid" />
          {SHAPES.map((s, i) => (
            <svg
              key={s.name}
              className="splash-shape"
              viewBox="0 0 100 100"
              style={{ left: `${s.left}%`, top: `${s.top}%`, width: `${s.width}%`, ["--i" as string]: i, ["--rot" as string]: `${s.rot}deg`, color: s.color }}
            >
              <path d={s.d} pathLength={400} />
            </svg>
          ))}
          {DOTS.map((d, i) => (
            <span key={i} className="splash-dot" style={{ left: `${d.left}%`, top: `${d.top}%`, background: d.color, ["--i" as string]: i }} />
          ))}
        </div>

        {/* 3) 워드마크 */}
        <div className="splash-word">
          {BRAND.map((ch, i) => (
            <span key={i} className="splash-letter" style={{ ["--i" as string]: i }}>
              {ch === "Λ" ? <Lambda /> : ch}
            </span>
          ))}
        </div>

        {/* 4) 밑줄·제목·부서 */}
        <div className="splash-underline" />
        <div className="splash-title">정비사업 지도</div>
        <div className="splash-dept">도시정비사업본부</div>
      </div>
      <div className="splash-hint">클릭하면 바로 들어갑니다</div>
    </div>
  );
}
