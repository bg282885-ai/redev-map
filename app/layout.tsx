import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { SplashIntro } from "@/components/SplashIntro";
import "leaflet/dist/leaflet.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "정비사업 지도 · HAENGLIM",
  description: "서울 재개발·재건축 정비구역을 지도에서 보고, 구역별 사업 현황과 관련 고시·공고로 바로 연결합니다.",
  applicationName: "HAENGLIM 정비사업 지도",
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
        {/* 진입 인트로 게이트: hydration 전에 실행되어 첫 방문 세션이면 <html class="hl-splash"> 를 붙임 */}
        <Script src="/splash-init.js" strategy="beforeInteractive" />
      </head>
      <body className="h-full overflow-hidden bg-white text-gray-900">
        <SplashIntro />
        {children}
      </body>
    </html>
  );
}
