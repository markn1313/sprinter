"use client";

export async function api<T = unknown>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export function postJson<T = unknown>(token: string, path: string, body: unknown): Promise<T> {
  return api<T>(token, path, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}
