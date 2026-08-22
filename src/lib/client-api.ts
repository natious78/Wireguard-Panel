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
  if (!response.ok) {
    const fallback:Record<number,string>={401:"Your session has expired. Sign in again and retry.",403:"You do not have permission to perform this operation.",404:"The requested record no longer exists. Refresh the page.",409:"The record changed or conflicts with current router state. Refresh and review it before retrying.",422:"Some values are invalid. Review the form and try again.",500:"The server could not confirm this operation. No change should be assumed; review application logs before retrying.",502:"A required upstream service did not respond. Check the router or database connection.",503:"The service is temporarily unavailable. Wait briefly, then retry."};
    throw new Error(payload.error || fallback[response.status] || `The operation could not be completed (HTTP ${response.status}).`);
  }
  return payload.data as T;
}
