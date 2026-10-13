import { QueryClient, QueryFunction } from "@tanstack/react-query";

const proxy = "__PORT_5000__";
const localPage = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
// Downloaded frontend assets must never retain a cloud proxy endpoint.
export const API_BASE = localPage
  ? (import.meta.env.VITE_API_BASE || (["5173", "4173"].includes(location.port) ? "http://127.0.0.1:5000" : ""))
  : (proxy.startsWith("__") ? "" : proxy);

const backendMissing = "Сервер Forma недоступен. Запустите полный проект командой npm run dev и откройте http://127.0.0.1:5000. Запуск одного фронтенда не запускает Ollama-подключение.";
async function request(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try { res = await fetch(`${API_BASE}${url}`, init); }
  catch (error: any) { if (error.name === "AbortError") throw error; throw new Error(backendMissing); }
  if (!res.headers.get("content-type")?.match(/application\/(json|x-ndjson)/i)) {
    throw new Error("Вместо API сервер вернул HTML или файл. " + backendMissing);
  }
  return res;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    let message = text;
    try { message = JSON.parse(text).message || text; } catch {}
    throw new Error(message);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await request(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    signal,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await request(queryKey.join("/"));

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
