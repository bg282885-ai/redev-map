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

export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, themeColor: "#ffffff" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className="h-full" suppressHydrationWarning>
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"
          crossOrigin="anonymous"
        />
        {/* 진입 인트로 게이트: 본문이 그려지기 전에 동기 실행되어 <html class="hl-splash"> + 흰 덮개를 붙임 */}
        <script dangerouslySetInnerHTML={{ __html: SPLASH_GATE }} />
      </head>
      <body className="h-full overflow-hidden bg-white text-gray-900">
        <SplashIntro />
        {children}
      </body>
    </html>
  );
}
