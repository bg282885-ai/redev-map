import type { Metadata, Viewport } from "next";
import { SplashIntro } from "@/components/SplashIntro";
import "leaflet/dist/leaflet.css";
import "./globals.css";
import { SPLASH_GATE } from "@/lib/splash-gate";

export const metadata: Metadata = {
  title: "정비사업 지도 · HAENGLIM",
  description: "서울 재개발·재건축 정비구역을 지도에서 보고, 구역별 사업 현황과 관련 고시·공고로 바로 연결합니다.",
  applicationName: "HAENGLIM 정비사업 지도",
  // 허브 앱 창에서 넘어와도 창 아이콘이 바뀌지 않도록 허브와 같은 H 아이콘 사용
  icons: { icon: [{ url: "/icons/hub-192.png", sizes: "192x192", type: "image/png" }] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1115" },
  ],
};

/** 첫 그림 전에 테마 결정: ?theme= > localStorage(hub-theme) > OS 설정. 깜빡임 방지용 인라인 스크립트 (허브와 동일, components/ThemeToggle.tsx) */
const THEME_SCRIPT =
  '(function(){try{var q=new URLSearchParams(location.search).get("theme");var t=q==="dark"||q==="light"?q:localStorage.getItem("hub-theme");if(q==="dark"||q==="light")localStorage.setItem("hub-theme",q);if(t!=="dark"&&t!=="light")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";if(t==="dark")document.documentElement.classList.add("dark")}catch(e){}})()';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className="h-full" suppressHydrationWarning>
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"
          crossOrigin="anonymous"
        />
        {/* 테마 먼저(html.dark) — 인트로 게이트가 덮개 색을 테마에 맞추므로 순서 유지 */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* 진입 인트로 게이트: 본문이 그려지기 전에 동기 실행되어 <html class="hl-splash"> + 바탕색 덮개를 붙임 */}
        <script dangerouslySetInnerHTML={{ __html: SPLASH_GATE }} />
      </head>
      <body className="h-full overflow-hidden bg-bg text-ink">
        <SplashIntro />
        {children}
      </body>
    </html>
  );
}
