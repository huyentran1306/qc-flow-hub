export class IntegrationError extends Error {
  constructor(public system: string, message: string, public status?: number) {
    super(`${system}: ${message}`);
  }
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 20000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
