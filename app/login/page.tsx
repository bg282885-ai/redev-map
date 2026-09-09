import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { ACCESS_COOKIE, ACCESS_MAX_AGE, accessToken, gateEnabled } from "@/lib/access";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

async function login(formData: FormData) {
  "use server";
  const code = String(formData.get("code") ?? "").trim();
  const next = String(formData.get("next") ?? "/");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  if (!process.env.ACCESS_CODE || code !== process.env.ACCESS_CODE) {
    redirect(`/login?error=1&next=${encodeURIComponent(safeNext)}`);
  }
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, await accessToken(code), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ACCESS_MAX_AGE,
    path: "/",
  });
  redirect(safeNext);
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<SP> }) {
  if (!gateEnabled()) redirect("/");
  const sp = await searchParams;
  const next = (Array.isArray(sp.next) ? sp.next[0] : sp.next) ?? "/";
  const error = Boolean(sp.error);

  return (
    <main className="mx-auto flex h-full max-w-sm flex-col justify-center overflow-auto px-6">
      <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-4 flex items-baseline gap-1.5">
          <span className="text-[17px] font-black tracking-tight text-brand">HAENGLIM</span>
          <span className="text-[14px] font-bold text-ink">정비사업 지도</span>
        </div>
        <h1 className="text-lg font-bold">접속 코드 입력</h1>
        <p className="mt-1 text-sm text-muted">부서 공용 코드를 입력하면 이 기기에서 180일간 다시 묻지 않습니다.</p>
        <form action={login} className="mt-4 space-y-3">
          <input type="hidden" name="next" value={next} />
          <input
            type="password"
            name="code"
            required
            autoFocus
            autoComplete="current-password"
            placeholder="접속 코드"
            className="w-full rounded-lg border border-line-3 bg-surface px-3 py-2.5 text-base text-ink outline-none focus:border-brand"
          />
          {error && <p className="text-sm text-danger">코드가 맞지 않습니다.</p>}
          <button className="w-full rounded-lg bg-brand py-2.5 text-sm font-semibold text-white hover:opacity-90">입장</button>
        </form>
      </div>
    </main>
  );
}
