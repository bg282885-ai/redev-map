// 부서 공용 접속 코드 게이트 (redev-news 와 같은 방식). ACCESS_CODE 가 비어 있으면 게이트를 끈다.
// 쿠키에는 코드 자체가 아니라 SHA-256 해시를 저장한다 (Edge/Node 양쪽에서 동작하도록 Web Crypto 사용).

export const ACCESS_COOKIE = "rm_access";
export const ACCESS_MAX_AGE = 60 * 60 * 24 * 180; // 180일

export async function accessToken(code: string) {
  const data = new TextEncoder().encode(`redev-map:${code}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function gateEnabled() {
  return Boolean(process.env.ACCESS_CODE);
}
