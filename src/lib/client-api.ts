export function getCookie(name: string) {
  return document.cookie.split("; ").find((item) => item.startsWith(`${name}=`))?.split("=").slice(1).join("=");
}

export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  let csrf = getCookie("wg_csrf");
  if (!csrf) {
    await fetch("/api/csrf", { credentials: "same-origin", cache: "no-store" });
    csrf = getCookie("wg_csrf");
  }
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(csrf ? { "X-CSRF-Token": decodeURIComponent(csrf) } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed with HTTP ${response.status}.`);
  return payload.data as T;
}
