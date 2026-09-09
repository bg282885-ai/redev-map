"use client";

import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "hub-theme";

/** 현재 적용된 테마(html.dark 기준) */
export function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function applyTheme(t: Theme, persist = true) {
  const html = document.documentElement;
  html.classList.add("theme-anim");
  html.classList.toggle("dark", t === "dark");
  if (persist) {
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* 사생활 보호 모드 등 */
    }
  }
  window.setTimeout(() => html.classList.remove("theme-anim"), 300);
  window.dispatchEvent(new CustomEvent("hub:theme", { detail: t }));
}

/**
 * 다크·라이트 토글. 첫 그림 전에 layout.tsx 의 인라인 스크립트가 ?theme= → localStorage(hub-theme) → OS 설정 순으로 html.dark 를 정한다.
 * 허브 카드에서 열릴 때 ?theme= 로 같은 테마가 넘어온다.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    setTheme(currentTheme());
    const on = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener("hub:theme", on);
    return () => window.removeEventListener("hub:theme", on);
  }, []);
  const dark = theme === "dark";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={dark ? "라이트 모드로 전환" : "다크 모드로 전환"}
      title={dark ? "라이트 모드" : "다크 모드"}
      className={`theme-toggle ${dark ? "on" : ""} ${className}`}
      onClick={() => applyTheme(dark ? "light" : "dark")}
    >
      <span className="theme-toggle-knob" aria-hidden="true">
        {dark ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        )}
      </span>
      <span className="theme-toggle-label">{dark ? "다크" : "라이트"}</span>
    </button>
  );
}
