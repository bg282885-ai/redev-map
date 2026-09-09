import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, accessToken } from "@/lib/access";

/** ACCESS_CODE 가 설정된 경우, 코드를 입력한 브라우저(쿠키)만 화면·API 에 접근할 수 있게 한다 */
export async function proxy(request: NextRequest) {
  const code = process.env.ACCESS_CODE;
  if (!code) return NextResponse.next();

  const cookie = request.cookies.get(ACCESS_COOKIE)?.value;
  if (cookie && cookie === (await accessToken(code))) return NextResponse.next();

  // API·데이터 요청은 로그인 페이지로 보내지 않고 401
  if (request.nextUrl.pathname.startsWith("/api/") || request.nextUrl.pathname.startsWith("/data/")) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  const next = request.nextUrl.pathname + request.nextUrl.search;
  if (next && next !== "/") url.searchParams.set("next", next);
  // 허브에서 넘어온 테마는 로그인 화면에도 바로 적용되게 같이 넘긴다
  const theme = request.nextUrl.searchParams.get("theme");
  if (theme === "dark" || theme === "light") url.searchParams.set("theme", theme);
  return NextResponse.redirect(url);
}

export const config = {
  // 정적 파일, 아이콘, 로그인 페이지는 제외
  matcher: ["/((?!_next/|login|favicon\\.ico|.*\\.(?:png|svg|ico|jpg|webp)$).*)"],
};
