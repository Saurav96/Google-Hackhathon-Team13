export async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${response.status}).`);
  }
  return response.json();
}

export const usd = (n) => `$${Number(n).toLocaleString("en-US")}`;
export const pct = (x) => `${(100 * x).toFixed(1)}%`;
export const smallPct = (x) => (x < 0.01 ? `${(100 * x).toFixed(2)}%` : pct(x));
export const roleOf = (role) => (role || "").split(" (")[0];
