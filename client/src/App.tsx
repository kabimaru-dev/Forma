import { useState, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Plus, Search, Settings2, ArrowUp, ArrowUpRight, ChevronDown, ChevronRight, PanelLeftClose, PanelLeft, Sun, Moon, CircleHelp, MessageSquare, SlidersHorizontal, Paperclip, X, FileText, Pencil, Code2, Lightbulb, GraduationCap, ArrowRight, Download, RefreshCw, Check, Copy, Trash2, Ellipsis, Monitor, Plug, Square, Loader2, ExternalLink, CheckCircle2, Circle, LockKeyhole, LogOut } from "lucide-react";
import { Sidebar, SidebarProvider, SidebarContent, SidebarFooter, SidebarHeader, useSidebar } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Form } from "@/components/ui/form";
import { queryClient, apiRequest, API_BASE } from "@/lib/queryClient";
import type { Settings, Chat, Message } from "@shared/schema";
import { defaultSettings } from "@shared/defaults";
import Computer from "./Computer";
import ModePicker, { modeId, readableMode, type Level, type Reasoning, type Speed, type ModeSelection, type ModesPublic } from "@/components/ModePicker";

type Model = { name: string; size: number; remote_host?: string; details?: { parameter_size?: string; quantization_level?: string; family?: string } };
type Status = { connected: boolean; reconnecting?: boolean; host: string; models: Model[]; backend?: boolean; message?: string; editable?: boolean; preview?: boolean };
type PendingAttachment = { id: string; name: string; kind: "text" | "image"; text?: string; data?: string; mimeType?: "image/jpeg" | "image/png" | "image/webp" | "image/gif" };
type ChatSummary = Omit<Chat, "owner" | "messages"> & { preview: string; count: number };

// llama.cpp n_gen corresponds to Ollama eval_count, summed over replies whose
// original generation statistics were actually received and saved.
type ContextUsage = { tokens: number | null; knownTokens: number; missing: number; context: number };

const prompts = [
  { icon: Pencil, title: "Найти нужные слова", text: "Письма, тексты и свежий взгляд", prompt: "Помоги написать текст. Сначала задай мне вопросы об аудитории, цели и желаемом стиле." },
  { icon: Code2, title: "Разобраться в коде", text: "От первой строки до решения", prompt: "Помоги разобраться с кодом. Уточни язык программирования и задачу, которую я хочу решить." },
  { icon: Lightbulb, title: "Придумать что-то новое", text: "Превратим мысль в хорошую идею", prompt: "Давай устроим мозговой штурм. Сначала спроси, для какой задачи мне нужны идеи." },
  { icon: GraduationCap, title: "Понять сложное", text: "Просто, наглядно, по шагам", prompt: "Помоги изучить новую тему. Спроси, что меня интересует и что я уже об этом знаю." },
];

function Logo({ className = "" }: { className?: string }) {
  return <svg className={className} width="34" height="34" viewBox="0 0 40 40" fill="none" aria-label="Forma"><path d="M7 7h27L21 20H7V7Zm0 18h16L7 39V25Z" fill="currentColor" /></svg>;
}
function IconButton({ label, children, onClick, disabled, className = "", testid }: { label: string; children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string; testid?: string }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled} data-testid={testid || `button-${label}`}>{children}</button>;
}
async function readStream(response: Response, callback: (value: any) => void) {
  if (!response.body) throw new Error("Сервер не вернул ответ.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n"); buffer = lines.pop() || "";
    for (const line of lines) if (line.trim()) callback(JSON.parse(line));
  }
  buffer += decoder.decode();
  if (buffer.trim()) callback(JSON.parse(buffer));
}
function Markdown({ text, copy }: { text: string; copy: (s: string) => void }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
    pre: ({ children }) => <div className="code-wrapper"><div className="code-top"><span>Код</span><button data-testid="button-copy-code" onClick={() => {
      const child = children as any; copy(String(child?.props?.children || ""));
    }}><Copy size={14} /> Копировать</button></div><pre>{children}</pre></div>,
  }}>{text}</ReactMarkdown>;
}
function Workspace({ user }: { user: { id: string; username: string } }) {
  const [location, navigate] = useLocation();
  const chatId = location.startsWith("/chat/") ? location.split("/")[2] : null;
  const isComputer = location === "/computer";
  const { open, toggleSidebar, setOpenMobile, isMobile } = useSidebar();
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const settingsQuery = useQuery<Settings>({ queryKey: ["/api/settings"] });
  const settings = settingsQuery.data || defaultSettings;
  // Ollama may be unavailable to the short status probe during a large load.
  // Don't keep probing while an answer is being streamed.
  const statusQuery = useQuery<Status>({
    queryKey: ["/api/status"],
    // Retry automatically when Ollama starts/restarts. During active
    // generation avoid contending with a model that is still loading.
    refetchInterval: query => busy ? false : (query.state.data?.connected && !query.state.data?.reconnecting ? 25000 : 3000),
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  const status: Status | undefined = statusQuery.isError ? { connected: false, backend: false, host: "", models: [], editable: false, message: (statusQuery.error as Error).message } : statusQuery.data;
  const chatsQuery = useQuery<ChatSummary[]>({ queryKey: ["/api/chats"] });
  const chats = chatsQuery.data || [];
  const chatQuery = useQuery<Chat>({ queryKey: ["/api/chats", chatId || ""], enabled: !!chatId });
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("connection");
  const [helpOpen, setHelpOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const modesQuery = useQuery<ModesPublic>({ queryKey: ["/api/modes"], staleTime: 5000, refetchInterval: 15000 });
  const [modeSelection, setModeSelection] = useState<ModeSelection>(() => {
    const read = <T extends string>(key: string, options: readonly T[], fallback: T): T => {
      const item = localStorage.getItem(`forma.${key}`) as T | null;
      return item && options.includes(item) ? item : fallback;
    };
    // Keep saved choices from earlier Forma versions without changing any chat data.
    const previous: Record<string, Level> = { core: "minimal", plus: "moderate", pro: "intensive", ultra: "extreme" };
    const storedLevel = localStorage.getItem("forma.level") || "";
    return {
      level: read<Level>("level", ["minimal", "moderate", "intensive", "extreme"], previous[storedLevel] || "moderate"),
      reasoning: read<Reasoning>("reasoning", ["minimal", "low", "medium", "high", "extra_high", "max", "ultra"], "medium"),
      speed: read<Speed>("speed", ["normal", "fast"], "normal"),
      model: read("mode-model", ["default", "model_02", "model_03", "model_04", "model_05", "model_06", "model_07"], "default"),
    };
  });
  const [chatMenu, setChatMenu] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [live, setLive] = useState<{ id: string; messages: Message[] } | null>(null);
  const [rename, setRename] = useState<ChatSummary | null>(null);
  const [renameText, setRenameText] = useState("");
  const [deleteChat, setDeleteChat] = useState<ChatSummary | null>(null);
  const [modalError, setModalError] = useState("");
  const [operation, setOperation] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const controller = useRef<AbortController | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const messages = live?.id === chatId ? live.messages : chatQuery.data?.messages || [];
  const models = status?.models || [];
  const model = (chatQuery.data?.model?.startsWith("forma:") ? "" : chatQuery.data?.model) || settings.model || models[0]?.name || "";
  const sendModel = modeId(modeSelection);
  const current = chats.find(c => c.id === chatId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editError, setEditError] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Refresh on chat selection or new answer. Usage is exact Ollama eval_count
  // for completed answers only; old answers without metadata stay unknown.
  const usageQuery = useQuery<ContextUsage>({
    queryKey: ["chat-generated-tokens", chatId, chatQuery.data?.updatedAt, settings.context, settings.contextStep, settings.contextPreload],
    enabled: !!chatId && !isComputer && !!chatQuery.data && !busy,
    queryFn: async ({ signal }) => {
      const response = await apiRequest("GET", `/api/chats/${chatId}/tokens`, undefined, signal);
      return response.json();
    },
    staleTime: Infinity,
    retry: false,
  });
  const tokenContext = usageQuery.data?.context ?? (settings.contextStep > 0 ? Math.max(2048, settings.contextStep) : settings.context);
  const tokenCount = !chatId ? 0 : usageQuery.data?.tokens;
  const tokenLabel = `Токенов: ${usageQuery.isFetching || busy ? "…" : tokenCount ?? "—"} / ${tokenContext}`;
  const tokenHint = usageQuery.isError
    ? `Не удалось прочитать статистику генерации: ${(usageQuery.error as Error).message}. Нажмите для повтора.`
    : usageQuery.data?.missing
      ? `Сгенерировано (n_gen из Ollama): известно ${usageQuery.data.knownTokens}, но для ${usageQuery.data.missing} старых или прерванных ответов нет исходных точных значений. Нажмите для обновления.`
      : "Число сгенерированных моделью токенов (n_gen = eval_count Ollama). Это не размер контекста. Нажмите для обновления.";

  // Message edits are persisted to the existing chats.messages JSON column in SQLite.
  // The composer draft is independent and is never overwritten by editing.
  const displayMessages = messages;
  const startEdit = (m: Message) => {
    if (busy || savingEdit) return;
    setEditingId(m.id);
    setEditText(m.content ?? "");
    setEditError("");
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditText("");
    setEditError("");
  };
  const jumpToMessage = (index: number) => {
    const message = displayMessages[index];
    if (!message) return;
    startEdit(message);
    requestAnimationFrame(() => document.querySelector(`[data-testid="message-${index}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };
  async function patchMessage(messageId: string, patch: { content: string } | { revisionIndex: number }) {
    if (!chatId || busy || savingEdit) return;
    setSavingEdit(true);
    setEditError("");
    try {
      const res = await apiRequest("PATCH", `/api/chats/${chatId}/messages/${messageId}`, patch);
      const data: { message: Message } = await res.json();
      queryClient.setQueryData<Chat>(["/api/chats", chatId], old => old
        ? { ...old, messages: old.messages.map(m => m.id === messageId ? data.message : m), updatedAt: Date.now() }
        : old);
      if (live?.id === chatId) setLive(old => old?.id === chatId ? {
        ...old, messages: old.messages.map(m => m.id === messageId ? data.message : m),
      } : old);
      await queryClient.invalidateQueries({ queryKey: ["/api/chats"], exact: true });
      setEditingId(null);
      setEditText("");
      setNotice("Изменение сохранено в истории");
    } catch (e: any) {
      setEditError(e.message || "Не удалось сохранить изменение.");
    } finally { setSavingEdit(false); }
  }
  async function saveEdit(m: Message) {
    const text = editText.trim();
    if (!text) { setEditError("Сообщение не может быть пустым."); return; }
    if (text === m.content) { cancelEdit(); return; }
    await patchMessage(m.id, { content: text });
  }


  useEffect(() => {
    if (settingsQuery.data) {
      const next = settings.theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : settings.theme;
      setTheme(next);
    }
  }, [settings.theme, settingsQuery.data]);
  useEffect(() => {
    localStorage.removeItem("forma.manualMode");
    localStorage.setItem("forma.level", modeSelection.level);
    localStorage.setItem("forma.reasoning", modeSelection.reasoning);
    localStorage.setItem("forma.speed", modeSelection.speed);
    localStorage.setItem("forma.mode-model", modeSelection.model || "default");
  }, [modeSelection]);
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle("dark", theme === "dark"); }, [theme]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => { if (settings.theme === "system") setTheme(media.matches ? "dark" : "light"); };
    media.addEventListener("change", update); return () => media.removeEventListener("change", update);
  }, [settings.theme]);
  useEffect(() => {
    setError("");
    cancelEdit();
    setOpenMobile(false);
    // Draft is intentionally not cleared here: send() owns the send lifecycle.
  }, [location]);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTo({ top: scroll.current.scrollHeight, behavior: busy ? "instant" : "smooth" });
  }, [messages.length, messages.at(-1)?.content, busy]);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(""), 2600); return () => clearTimeout(timer); } }, [notice]);
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearchOpen(true); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); newChat(); }
    };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, []);
  function newChat() { navigate("/"); setDraft(""); setAttachment(null); setError(""); setOpenMobile(false); textarea.current?.focus(); }
function goTo(path: string) { navigate(path); setOpenMobile(false); }
  async function logout() {
    try { await apiRequest("POST", "/api/auth/logout"); } catch {}
    queryClient.removeQueries({ predicate: q => q.queryKey[0] !== "/api/auth/me" });
    queryClient.setQueryData(["/api/auth/me"], { user: null });
    window.location.hash = "#/";
  }
  function openSettings(tab = "connection") { setSettingsTab(tab); setSettingsOpen(true); }
  async function saveSettings(next: Settings) {
    const res = await apiRequest("PUT", "/api/settings", next);
    queryClient.setQueryData(["/api/settings"], await res.json());
  }
  async function changeTheme() {
    const next = theme === "light" ? "dark" : "light"; setTheme(next);
    try { await saveSettings({ ...settings, theme: next }); } catch { setNotice("Тема изменена, но не сохранена. Проверьте соединение."); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice("Скопировано"); }
    catch { setNotice("Браузер не разрешил копирование. Выделите текст вручную."); }
  }
  async function attach(files: FileList | File[] | null | undefined) {
    if (!files?.length) return;
    const accepted: PendingAttachment[] = [];
    try {
      for (const file of Array.from(files)) {
        if (file.type.startsWith("image/") && ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
          if (file.size > 8 * 1024 * 1024) throw new Error(`«${file.name}»: максимальный размер фотографии 8 МБ.`);
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
          });
          const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
          accepted.push({ id: crypto.randomUUID(), name: file.name, kind: "image", mimeType: file.type as PendingAttachment["mimeType"], data });
        } else if (/\.(txt|md|csv|json|js|ts|tsx|jsx|py|html|css|yml|yaml|log)$/i.test(file.name)) {
          if (file.size > 100000) throw new Error(`«${file.name}»: максимальный размер текстового файла 100 КБ.`);
          const text = await file.text();
          if (text.includes("\0")) throw new Error(`«${file.name}» содержит бинарные данные.`);
          accepted.push({ id: crypto.randomUUID(), name: file.name, kind: "text", text });
        } else throw new Error(`Неподдерживаемый тип файла: ${file.name}.`);
      }
      setAttachments(previous => [...previous, ...accepted]);
      setError("");
    } catch (e: any) { setError(e?.message || "Не удалось добавить файлы."); }
    finally { if (fileInput.current) fileInput.current.value = ""; }
  }
  async function send(retry = false) {
    if (busy || (!retry && !draft.trim() && !attachments.length)) return;
    if (status?.backend === false) { setError("Сервер Forma недоступен. Ваш текст останется здесь."); return; }
    if (modesQuery.data && (modeSelection.model && modeSelection.model !== "default"
      ? !modesQuery.data.modelChoices?.[modeSelection.model]?.enabled || !modesQuery.data.levels[modeSelection.level] || !modesQuery.data.reasoning[modeSelection.level][modeSelection.reasoning] || !modesQuery.data.speed[modeSelection.speed]
      : !modesQuery.data.available?.[modeSelection.level]?.[modeSelection.reasoning]?.[modeSelection.speed])) {
      setError("Режим не настроен: укажите модель в config/modes.yaml на сервере Forma."); return;
    }
    const content = `${draft.trim()}${attachments.filter(f => f.kind === "text").map(f => `\n\nФайл: ${f.name}\n\`\`\`\n${f.text}\n\`\`\``).join("")}`.trim();
    const images = attachments.filter(f => f.kind === "image").map(f => ({ name: f.name, mimeType: f.mimeType!, data: f.data! }));
    if (images.reduce((total, f) => total + f.data.length * .75, 0) > 24 * 1024 * 1024) { setError("Максимальный общий размер фотографий — 24 МБ за сообщение."); return; }
    if (content.length > 100000) { setError("Сообщение вместе с файлом должно быть короче 100 000 символов."); return; }
    setError(""); setBusy(true);
    if (!retry) { setDraft(""); setAttachments([]); }
    let id = chatId;
    const aborter = new AbortController(); controller.current = aborter;
    let started = false;
    let finished = false;
    let serverComplete = false;
    let history = [...(chatQuery.data?.messages || [])];
    if (retry) { while (history.at(-1)?.role === "assistant") history.pop(); }
    else history.push({ id: "pending-user", role: "user", content });
    let assistant: Message = { id: "stream-assistant", role: "assistant", content: "", model: sendModel };
    const snapshot = () => [
      ...history,
      ...(assistant.content || assistant.thinking ? [{ ...assistant, interrupted: !serverComplete }] : []),
    ];
    const showPartial = (activeId: string) => setLive({ id: activeId, messages: [
      ...history,
      { ...assistant, interrupted: false },
    ] });
    try {
      if (!id) {
        const res = await apiRequest("POST", "/api/chats", { title: content.slice(0, 65) || images[0]?.name || "Новый диалог", model: sendModel });
        const created = await res.json(); id = created.id; navigate(`/chat/${id}`);
      }
      const activeId = id!;
      showPartial(activeId);
      // Never lose the typed message when a request fails before the stream begins.
      // The backend stores the user message before contacting Ollama.
      await queryClient.invalidateQueries({ queryKey: ["/api/chats"], exact: true });
      const response = await apiRequest("POST", `/api/chats/${id}/send`, { content, model: sendModel, retry, images: retry ? [] : images }, aborter.signal);
      await readStream(response, event => {
        if (event.type === "vision") setNotice(`Обработка фотографий: ${event.current} / ${event.total}`);
        if (event.type === "reconnecting") setReconnecting(true);
        if (event.type === "context" || event.type === "token" || event.type === "thinking" || event.type === "done") setReconnecting(false);
        if (event.type === "start") {
          started = true;
          if (Array.isArray(event.messages)) history = event.messages;
          if (typeof event.assistantId === "string") assistant.id = event.assistantId;
        }
        if (event.type === "thinking" && typeof event.content === "string") {
          assistant.thinking = (assistant.thinking || "") + event.content;
        }
        if (event.type === "token" && typeof event.content === "string") assistant.content += event.content;
        if (event.type === "error") setError(event.message);
        if (event.type === "done") { finished = true; serverComplete = event.complete !== false; }
        if (event.type === "start" || event.type === "token" || event.type === "thinking" || event.type === "done") showPartial(activeId);
      });
      if (!finished) throw new Error("Соединение с моделью оборвалось. Полученная часть ответа сохранена.");
    } catch (e: any) {
      if (e.name !== "AbortError") setError(e.message || "Не удалось отправить сообщение.");
      else setNotice("Генерация остановлена");
      serverComplete = false;
    } finally {
      if (aborter.signal.aborted && id) {
        try { await apiRequest("POST", `/api/chats/${id}/stop`, {}); } catch {}
      }
      if (id) {
        const key = ["/api/chats", id];
        if (started || assistant.content || assistant.thinking) {
          // Keep received text in the React Query cache even if the subsequent
          // history refresh fails or returns a stale/partial snapshot.
          const local = snapshot();
          queryClient.setQueryData<Chat>(key, previous => previous
            ? { ...previous, messages: local, model: sendModel }
            : { id: id!, owner: user.id, title: content.slice(0, 65) || "Новый диалог", model: sendModel, updatedAt: Date.now(), messages: local });
        } else if (!retry && !started && !aborter.signal.aborted) {
          // The request may have failed before Ollama accepted the prompt.
          setDraft(draft);
          setAttachments(attachments);
        }
        try { await queryClient.invalidateQueries({ queryKey: key, exact: true }); } catch {}
        try { await queryClient.invalidateQueries({ queryKey: ["/api/chats"], exact: true }); } catch {}
      }
      setBusy(false);
      setReconnecting(false);
      void statusQuery.refetch();
      // A failed refresh must not make already received tokens disappear.
      if (id && (assistant.content || assistant.thinking)) {
        const cached = queryClient.getQueryData<Chat>(["/api/chats", id]);
        const stored = cached?.messages.find(m => m.id === assistant.id);
        if (!stored || stored.content.length < assistant.content.length || (stored.thinking?.length || 0) < (assistant.thinking?.length || 0)) {
          setLive({ id, messages: snapshot() });
        } else setLive(null);
      } else setLive(null);
      controller.current = null;
    }
  }
  const picker = <ModePicker
    disabled={busy}
    selection={modeSelection}
    available={modesQuery.data}
    onSelection={setModeSelection}
    onOpenSettings={() => openSettings("generation")}
  />;
  const composer = <div className="composer-wrap">
    <div className={`composer ${busy ? "generating" : ""}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void attach(e.dataTransfer.files); }}>
      {attachments.length > 0 && <div className="flex flex-wrap gap-2" data-testid="attachments">{attachments.map(file => <div className="attachment" key={file.id} data-testid="file-attachment"><FileText size={15}/><span>{file.name}</span><IconButton label="Убрать файл" onClick={() => setAttachments(previous => previous.filter(f => f.id !== file.id))}><X size={14}/></IconButton></div>)}</div>}
      <textarea ref={textarea} aria-label="Сообщение" data-testid="input-message" value={draft} onChange={e => { setDraft(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`; }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} placeholder="Спросите о чём угодно или поделитесь идеей…" rows={2}/>
      <div className="composer-tools"><div className="flex items-center gap-1"><IconButton label="Прикрепить файлы или фотографии" testid="button-attach" onClick={() => fileInput.current?.click()} disabled={busy}><Paperclip size={19}/></IconButton></div><div className="flex items-center gap-2">{picker}{busy ? <button className="send-button stop" aria-label="Остановить ответ" data-testid="button-stop" onClick={() => controller.current?.abort()}><Square size={17} fill="currentColor"/></button> : <button className="send-button" aria-label="Отправить сообщение" data-testid="button-send" disabled={!draft.trim() && !attachments.length} onClick={() => send()}><ArrowUp size={21}/></button>}</div></div>
    </div>
    <input ref={fileInput} type="file" multiple className="hidden" aria-label="Файлы и фотографии" data-testid="input-file" accept="image/jpeg,image/png,image/webp,image/gif,.txt,.md,.csv,.json,.js,.ts,.tsx,.jsx,.py,.html,.css,.yml,.yaml,.log" onChange={e => void attach(e.target.files)}/>
    {error && <div className="inline-error" role="alert" data-testid="error-chat">{error}<IconButton label="Скрыть ошибку" onClick={() => setError("")}><X size={14}/></IconButton></div>}
  </div>;

  return <div className="app-shell w-full">
    <button className="skip-link" data-testid="button-skip" onClick={() => textarea.current?.focus()}>К сообщению</button>
    <Sidebar className="app-sidebar" collapsible="offcanvas">
      <SidebarHeader className="brand-header"><button className="brand" onClick={newChat} data-testid="button-brand"><Logo/><span>forma<span className="brand-dot">.</span></span></button><IconButton label="Свернуть меню" testid="button-collapse-sidebar" onClick={toggleSidebar}><PanelLeftClose size={18}/></IconButton></SidebarHeader>
      <SidebarContent className="side-content">
        <button className="new-chat" data-testid="button-new-chat" onClick={newChat}><Plus size={18}/><span>Новый чат</span><kbd>⌘ ⇧ O</kbd></button>
        <nav className="main-nav" aria-label="Главное меню">
          <button data-testid="button-search" onClick={() => setSearchOpen(true)}><Search size={18}/><span>Поиск чатов</span><kbd>⌘ K</kbd></button>
          <button className={isComputer ? "active" : ""} data-testid="button-computer" onClick={() => goTo("/computer")}><Monitor size={18}/><span>Computer</span><span className="nav-beta">beta</span></button>
        </nav>
        <div className="history-heading">Ваши диалоги <span>{chats.length > 0 && chats.length}</span></div>
        <div className="history-list">
          {chatsQuery.isLoading ? <div className="history-skeleton"><div/><div/><div/></div> : chatsQuery.isError ? <button className="history-empty" data-testid="button-retry-history" onClick={() => chatsQuery.refetch()}>Не удалось загрузить историю. Нажмите, чтобы повторить.</button> : !chats.length ? <div className="history-empty"><MessageSquare size={21}/><p>Здесь начинается<br/>ваша история.</p><span>Первый диалог появится после отправки сообщения.</span></div> : chats.map(c => <div key={c.id} className={`history-row ${chatId === c.id ? "selected" : ""}`}>
            <button className="history-link" title={c.title} data-testid={`chat-${c.id}`} onClick={() => navigate(`/chat/${c.id}`)}><MessageSquare size={15}/><span>{c.title}</span></button>
            <Popover open={chatMenu === c.id} onOpenChange={v => setChatMenu(v ? c.id : null)}><PopoverTrigger asChild><button className="chat-more" aria-label={`Действия: ${c.title}`} data-testid={`actions-${c.id}`}><Ellipsis size={16}/></button></PopoverTrigger><PopoverContent className="chat-menu" align="start"><button data-testid={`rename-${c.id}`} onClick={() => { setChatMenu(null); setRename(c); setRenameText(c.title); setModalError(""); }}><Pencil size={15}/>Переименовать</button><a data-testid={`export-${c.id}`} href={`${API_BASE}/api/chats/${c.id}/export`} target="_blank" rel="noopener noreferrer" onClick={() => setChatMenu(null)}><Download size={15}/>Экспорт в Markdown</a><button className="danger-text" disabled={busy && live?.id === c.id} data-testid={`delete-${c.id}`} onClick={() => { setChatMenu(null); setDeleteChat(c); setModalError(""); }}><Trash2 size={15}/>Удалить чат</button></PopoverContent></Popover>
          </div>)}
        </div>
      </SidebarContent>
      <SidebarFooter className="side-footer">
        <button className="ollama-card" data-testid="button-connect-card" onClick={() => openSettings()}>
          <div className="ollama-card-top"><span className="connection-mark"><Plug size={17}/></span><span>Ваш AI. Ваши правила.</span></div>
          <p>{status?.connected ? `${models.length} моделей доступно в Ollama` : "Forma подключится к Ollama автоматически, как только сервер станет доступен."}</p>
          <span className="connect-link">{status?.connected ? "Ollama подключена" : "Автоподключение Ollama"}<ArrowRight size={14}/></span>
        </button>
        <div className="side-footer-links"><button data-testid="button-help" onClick={() => { setOpenMobile(false); setHelpOpen(true); }}><CircleHelp size={17}/>Как это работает</button><button data-testid="button-settings" onClick={() => { setOpenMobile(false); openSettings(); }}><Settings2 size={17}/>Настройки</button></div>
        <div className="profile"><span className="profile-avatar">{user.username.slice(0, 1).toUpperCase()}</span><div>{user.username}<small>Личный аккаунт</small></div><IconButton label="Выйти" testid="button-logout" onClick={logout}><LogOut size={17}/></IconButton><IconButton label={theme === "light" ? "Тёмная тема" : "Светлая тема"} testid="button-theme-sidebar" onClick={changeTheme}>{theme === "light" ? <Moon size={17}/> : <Sun size={17}/>}</IconButton></div>
      </SidebarFooter>
    </Sidebar>
    <main className="main-panel">
      <header className="topbar"><div className="topbar-left">{(!open || isMobile) && <IconButton label="Открыть меню" testid="button-open-sidebar" onClick={toggleSidebar}><PanelLeft size={19}/></IconButton>}<span className="page-breadcrumb">Личное пространство</span><ChevronRight className="breadcrumb-chevron" size={13}/><span className="page-name">{isComputer ? "Computer" : current?.title || "Новый диалог"}</span><span className="forma-version" data-testid="forma-version" title="Версия Forma">v5.5</span></div><div className="topbar-right">{!isComputer && <button type="button" className="forma-token-counter" data-testid="token-counter" aria-label={tokenLabel} title={tokenHint} onClick={() => usageQuery.refetch()} disabled={!chatId || busy || usageQuery.isFetching}><span className="token-counter-label">Токенов:</span> <span>{tokenLabel.slice("Токенов: ".length)}</span></button>}<button className={`connection-status ${status?.connected ? "online" : ""}`} data-testid="status-connection" onClick={() => openSettings()}><span className="status-dot"/><span>{statusQuery.isFetching && !status ? "Проверяем Ollama" : status?.backend === false ? "Сервер Forma недоступен" : reconnecting || status?.reconnecting ? "Восстанавливаем Ollama…" : status?.connected ? "Ollama подключена" : "Ожидаем Ollama…"}</span></button><span className="topbar-divider"/><IconButton label={theme === "light" ? "Тёмная тема" : "Светлая тема"} testid="button-theme" onClick={changeTheme}>{theme === "light" ? <Moon size={18}/> : <Sun size={18}/>}</IconButton></div></header>
      {isComputer ? <Computer models={models} model={model} connected={!!status?.connected} connect={() => openSettings()}/> : chatId ? <>
        <div className="conversation-scroll" ref={scroll}>
          <div className="messages">
            {chatQuery.isLoading && !live ? (
              <div className="message-loading"><div /><div /><div /></div>
            ) : chatQuery.isError && !live ? (
              <div className="state-empty">
                <MessageSquare size={32} />
                <h1>Не удалось открыть диалог</h1>
                <p>Попробуйте загрузить его ещё раз.</p>
                <button
                  className="primary-button"
                  data-testid="button-reload-chat"
                  onClick={() => chatQuery.refetch()}
                >
                  Повторить
                </button>
              </div>
            ) : !displayMessages.length ? (
              <div className="state-empty">
                <Logo />
                <h1>Продолжим разговор?</h1>
                <p>Напишите первое сообщение в этом диалоге.</p>
              </div>
            ) : (
              displayMessages.map((m, i) => {
                const isEditing = editingId === m.id;

                return (
                  <article
                    key={m.id}
                    className={`message ${m.role}`}
                    data-testid={`message-${i}`}
                  >
                    {m.role === "assistant" && (
                      <div className="assistant-heading">
                        <Logo />
                        <span>forma</span>
                        <small>{readableMode(m.model)}</small>
                      </div>
                    )}

                    <div className="message-body">
                      {!isEditing && m.role === "assistant" && m.thinking && (
                        <details className="reasoning-panel" open={busy && live?.id === chatId && !m.content ? true : undefined}>
                          <summary>Ход рассуждений модели</summary>
                          <pre>{m.thinking}</pre>
                        </details>
                      )}
                      {isEditing ? (
                        <form
                          className="message-edit-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            saveEdit(m);
                          }}
                        >
                          <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            disabled={savingEdit || busy}
                            aria-label="Редактировать текст сообщения"
                            data-testid={`editor-message-${i}`}
                            rows={Math.max(2, Math.min(10, editText.split("\n").length + 1))}
                          />
                          {editError && <p className="inline-error" role="alert">{editError}</p>}
                          <div className="message-edit-actions">
                            <button type="button" disabled={i === 0 || savingEdit} onClick={() => jumpToMessage(i - 1)} title="Редактировать предыдущее сообщение">↑ Предыдущее</button>
                            <button type="button" disabled={i >= displayMessages.length - 1 || savingEdit} onClick={() => jumpToMessage(i + 1)} title="Редактировать следующее сообщение">↓ Следующее</button>
                            <button type="submit" disabled={savingEdit || busy || !editText.trim()}>Сохранить</button>
                            <button type="button" disabled={savingEdit} onClick={cancelEdit}>Отмена</button>
                          </div>
                        </form>
                      ) : m.content ? (
                        <Markdown text={m.content} copy={copy} />
                      ) : m.thinking && !busy ? (
                        <p className="reasoning-only">Окончательный ответ не получен. Сохранены рассуждения модели выше.</p>
                      ) : (
                        <div className="thinking">
                          <span />
                          <span />
                          <span />
                          <small>Модель готовит ответ</small>
                        </div>
                      )}
                    </div>

                    {m.interrupted && (
                      <small className="interrupted">Ответ прерван — полученная часть сохранена</small>
                    )}

                    {Array.isArray(m.revisions) && m.revisions.length > 1 && (
                      <div className="message-revisions" aria-label="История редакций">
                        <button type="button" disabled={busy || savingEdit || (m.revisionIndex ?? m.revisions.length - 1) === 0}
                          onClick={() => patchMessage(m.id, { revisionIndex: (m.revisionIndex ?? m.revisions!.length - 1) - 1 })} title="Предыдущая редакция">←</button>
                        <span>{(m.revisionIndex ?? m.revisions.length - 1) + 1} / {m.revisions.length}</span>
                        <button type="button" disabled={busy || savingEdit || (m.revisionIndex ?? m.revisions.length - 1) >= m.revisions.length - 1}
                          onClick={() => patchMessage(m.id, { revisionIndex: (m.revisionIndex ?? m.revisions!.length - 1) + 1 })} title="Следующая редакция">→</button>
                      </div>
                    )}
                    <div className="message-actions">
                      <IconButton
                        label="Копировать сообщение"
                        testid={`copy-message-${i}`}
                        onClick={() => copy(m.content)}
                      >
                        <Copy size={15} />
                      </IconButton>

                      {m.id !== "pending-user" && m.id !== "stream-assistant" && (
                        <IconButton
                          label="Изменить сообщение"
                          testid={`edit-message-${i}`}
                          disabled={busy || savingEdit}
                          onClick={() => startEdit(m)}
                        >
                          <Pencil size={15} />
                        </IconButton>
                      )}

                      {m.role === "assistant" &&
                        i === displayMessages.length - 1 &&
                        !busy && (
                          <IconButton
                            label="Ответить заново"
                            testid="button-regenerate"
                            onClick={() => send(true)}
                          >
                            <RefreshCw size={15} />
                          </IconButton>
                        )}
                    </div>
                  </article>
                );
              })
            )}

            {!busy && displayMessages.at(-1)?.role === "user" && (
              <button
                className="retry-answer"
                data-testid="button-retry-answer"
                onClick={() => send(true)}
              >
                <RefreshCw size={15} />
                Получить ответ
              </button>
            )}
          </div>
        </div>
        <div className="bottom-composer">{composer}<p className="composer-hint">Ответы моделей могут быть неточными. Проверяйте важное.</p></div>
      </> : <div className="welcome-page">
        <section className="welcome-content">
          <div className="welcome-brand"><Logo/><span>ПРОСТРАНСТВО ДЛЯ ВАШИХ ИДЕЙ</span></div>
          <h1>С чего начнём?</h1>
          <p className="welcome-subtitle">Большая идея или маленький вопрос.<br className="mobile-break"/> Давайте разберёмся вместе.</p>
          {composer}
          <div className="suggestion-header"><span>НЕМНОГО ВДОХНОВЕНИЯ</span><span>Или начните с чистого листа</span></div>
          <div className="suggestions">{prompts.map(({ icon: Icon, title, text, prompt }, i) => <button key={title} data-testid={`button-prompt-${i}`} onClick={() => { setDraft(prompt); textarea.current?.focus(); }}><div className="suggestion-title"><Icon size={18}/><span>{title}</span><ArrowUpRight size={15}/></div><p>{text}</p></button>)}</div>
          <div className="welcome-bottom"><LockKeyhole size={13}/><span>Ваши модели. Ваши разговоры. Ваш ритм.</span></div>
        </section>
        <footer className="welcome-footer"><span>Работает с <strong>Ollama</strong></span><span className="footer-dot">·</span><span>Больше пространства для мысли</span></footer>
      </div>}
    </main>
    <SettingsDialog open={settingsOpen} setOpen={setSettingsOpen} tab={settingsTab} setTab={setSettingsTab} settings={settings} save={saveSettings} status={status} refreshing={statusQuery.isFetching} refresh={() => statusQuery.refetch()} />
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}><DialogContent className="app-dialog help-dialog"><DialogHeader><DialogTitle>Знакомьтесь, Forma</DialogTitle><DialogDescription>Знакомый чат. Модели, которые выбираете вы.</DialogDescription></DialogHeader><div className="help-content"><div className="help-step"><span>01</span><div><h3>Запустите Ollama</h3><p>Установите Ollama на свой компьютер и откройте приложение. Сервер Forma должен работать на том же компьютере или иметь доступ к вашей Ollama.</p><a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" data-testid="link-ollama-download">Скачать Ollama<ExternalLink size={14}/></a></div></div><div className="help-step"><span>02</span><div><h3>Добавьте свою модель</h3><p>Установите модели через Ollama на своём компьютере и задайте их в config/modes.yaml на сервере Forma.</p></div></div><div className="help-step"><span>03</span><div><h3>Начните разговор</h3><p>Выберите уровень Forma, напишите сообщение или прикрепите файлы и фотографии. Для фотографий задайте vision_model в config/modes.yaml. История сохраняется в базе на сервере Forma.</p></div></div><div className="shortcuts"><span>Отправить <kbd>Enter</kbd></span><span>Новая строка <kbd>Shift + Enter</kbd></span><span>Поиск <kbd>Ctrl / ⌘ K</kbd></span></div></div></DialogContent></Dialog>
    <Dialog open={searchOpen} onOpenChange={setSearchOpen}><DialogContent className="app-dialog search-dialog"><DialogHeader><DialogTitle>Найти диалог</DialogTitle><DialogDescription>По названию или тексту сообщений</DialogDescription></DialogHeader><div className="search-input"><Search size={19}/><input autoFocus aria-label="Поиск диалогов" placeholder="О чём мы говорили?" data-testid="input-search" value={search} onChange={e => setSearch(e.target.value)}/></div><div className="search-results">{chats.filter(c => `${c.title} ${c.preview}`.toLowerCase().includes(search.toLowerCase())).map(c => <button key={c.id} data-testid={`search-result-${c.id}`} onClick={() => { navigate(`/chat/${c.id}`); setSearchOpen(false); }}><MessageSquare size={18}/><span>{c.title}<small>{c.preview.slice(0, 85) || "Пока без сообщений"}</small></span><ArrowUpRight size={16}/></button>)}{!chats.filter(c => `${c.title} ${c.preview}`.toLowerCase().includes(search.toLowerCase())).length && <div className="search-empty"><Search size={25}/><p>{search ? "Такого диалога пока нет" : "Ваши диалоги появятся здесь"}</p><small>{search ? "Попробуйте другое слово." : "Начните новый чат, и мы сохраним его для вас."}</small></div>}</div></DialogContent></Dialog>
    <Dialog open={!!rename} onOpenChange={v => { if (!v) setRename(null); }}><DialogContent className="app-dialog compact-dialog"><DialogHeader><DialogTitle>Название диалога</DialogTitle><DialogDescription>Так его будет проще найти в истории.</DialogDescription></DialogHeader><input className="text-input" aria-label="Название" value={renameText} onChange={e => setRenameText(e.target.value)} data-testid="input-rename" maxLength={120}/>{modalError && <p className="inline-error" role="alert">{modalError}</p>}<button className="primary-button" data-testid="button-save-rename" disabled={!renameText.trim() || operation} onClick={async () => { setOperation(true); try { await apiRequest("PATCH", `/api/chats/${rename!.id}`, { title: renameText }); await queryClient.invalidateQueries({ queryKey: ["/api/chats"] }); setRename(null); } catch(e: any) { setModalError(e.message); } finally { setOperation(false); } }}>Сохранить</button></DialogContent></Dialog>
    <Dialog open={!!deleteChat} onOpenChange={v => { if (!v) setDeleteChat(null); }}><DialogContent className="app-dialog compact-dialog"><DialogHeader><DialogTitle>Удалить диалог?</DialogTitle><DialogDescription>«{deleteChat?.title}» и все его сообщения будут удалены без возможности восстановления.</DialogDescription></DialogHeader>{modalError && <p role="alert" className="inline-error">{modalError}</p>}<div className="dialog-actions"><button className="secondary-button" data-testid="button-cancel-delete" onClick={() => setDeleteChat(null)}>Оставить</button><button className="primary-button danger" data-testid="button-confirm-delete" disabled={operation} onClick={async () => { setOperation(true); try { await apiRequest("DELETE", `/api/chats/${deleteChat!.id}`); if (chatId === deleteChat!.id) newChat(); await queryClient.invalidateQueries({ queryKey: ["/api/chats"] }); setDeleteChat(null); } catch(e: any) { setModalError(e.message); } finally { setOperation(false); } }}>Удалить диалог</button></div></DialogContent></Dialog>
    {notice && <div className="notice" role="status" data-testid="status-notice"><CheckCircle2 size={16}/>{notice}</div>}
  </div>;
}

function SettingsDialog({ open, setOpen, tab, setTab, settings, save, status, refreshing, refresh }: { open: boolean; setOpen: (v: boolean) => void; tab: string; setTab: (v: string) => void; settings: Settings; save: (s: Settings) => Promise<void>; status?: Status; refreshing: boolean; refresh: () => void }) {
  const form = useForm<Settings>({ defaultValues: settings });
  const [saved, setSaved] = useState(false), [error, setError] = useState("");
  const [host, setHost] = useState(""), [checking, setChecking] = useState(false), [connection, setConnection] = useState<Status | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualControl = form.register("context", { valueAsNumber: true });
  const stepControl = form.register("contextStep", { valueAsNumber: true });
  const preloadControl = form.register("contextPreload", { valueAsNumber: true });
  // Keep writes in order so a slow earlier request cannot overwrite a newer choice.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const sliderRevision = useRef(0);
  const pendingSlider = useRef<{ values: Settings; revision: number } | null>(null);
  function flushSlider() {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    const pending = pendingSlider.current;
    if (!pending) return;
    pendingSlider.current = null;
    void queueSettings(pending.values, pending.revision);
  }
  function queueSettings(values: Settings, revision: number): Promise<void> {
    const run = saveQueue.current.catch(() => {}).then(async () => {
      await save(values);
      if (revision === sliderRevision.current) { setError(""); setSaved(true); }
    }).catch((e: any) => {
      if (revision === sliderRevision.current) { setError(e?.message || "Не удалось сохранить настройки."); setSaved(false); }
    });
    saveQueue.current = run;
    return run;
  }
  function saveSlider(name: "context" | "contextStep" | "contextPreload", value: number) {
    // Settings belong to the account, not the active chat. Persist after each
    // slider adjustment, without requiring a separate manual Save action.
    setSaved(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const revision = ++sliderRevision.current;
    const values = { ...form.getValues(), [name]: value, contextDefaultsApplied: true, contextManualDefaultsApplied: true };
    pendingSlider.current = { values, revision };
    saveTimer.current = setTimeout(flushSlider, 350);
  }
  useEffect(() => () => {
    // Flush any pending slider choice when leaving the settings page.
    flushSlider();
  }, []);
  useEffect(() => { if (open) { form.reset(settings); setSaved(false); setError(""); setConnection(null); setHost(settings.ollamaUrl || status?.host || "http://127.0.0.1:11434"); } }, [open]);
  // When settings arrive from the server after the dialog is already open,
  // show the persisted values rather than stale form defaults.
  useEffect(() => { if (open && !saveTimer.current && !form.formState.isDirty) form.reset(settings); }, [settings, open]);
  async function checkConnection() {
    setChecking(true); setError(""); setConnection(null);
    try {
      const response = await apiRequest("POST", "/api/connection", { url: host });
      const result = await response.json();
      setConnection(result);
      if (result.saved) {
        setHost(result.host);
        form.setValue("ollamaUrl", result.host);
        queryClient.setQueryData(["/api/status"], result);
        await queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      }
    } catch(e: any) { setError(e.message); }
    finally { setChecking(false); }
  }
  const shown = connection || status;
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent className="app-dialog settings-dialog"><DialogHeader><DialogTitle>Настройки пространства</DialogTitle><DialogDescription>Пусть AI работает так, как удобно вам.</DialogDescription></DialogHeader><div className="dialog-tabs" role="tablist">{[["connection", "Подключение"], ["generation", "Ответы"], ["appearance", "Оформление"]].map(([id, label]) => <button role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} data-testid={`tab-${id}`} key={id} onClick={() => { setTab(id); setSaved(false); }}>{label}</button>)}</div>
    {tab === "connection" ? <div className="connection-settings">
      <div className={`connection-box ${shown?.connected ? "connected" : ""}`}><span className="connection-large">{shown?.connected ? <CheckCircle2 size={23}/> : <Plug size={23}/>}</span><div><h3>{shown?.backend === false ? "Не запущен сервер Forma" : shown?.connected ? "Ollama на связи" : "Подключение к Ollama"}</h3><p>{shown?.connected ? `Доступно моделей: ${shown.models.length}` : shown?.backend === false ? "Один фронтенд не подключается к Ollama." : "Forma переподключается автоматически. Для локальной Ollama пробует запустить установленный сервер."}</p></div><span className={`status-dot ${shown?.connected ? "green" : ""}`}/></div>
      <label className="field-label" htmlFor="ollama-url">Адрес вашей Ollama</label>
      <div className="host-field editable-host"><Monitor size={17}/><input id="ollama-url" data-testid="input-ollama-url" value={host} disabled={checking} onChange={e => { setHost(e.target.value); setConnection(null); }} placeholder="http://127.0.0.1:11434" onKeyDown={e => { if (e.key === "Enter" && !status?.preview) checkConnection(); }}/></div>
      <p className="field-hint">Адрес сохраняется и при временно недоступной Ollama. Forma будет подключаться к нему автоматически.</p>
      {shown?.message && <div className={`connection-feedback ${shown.connected ? "success" : ""}`} role="status" data-testid="status-connection-details">{shown.message}</div>}
      {error && <p className="inline-error" role="alert" data-testid="error-connection">{error}</p>}
      
      
      <div className="dialog-actions"><button className="secondary-button" data-testid="button-refresh-backend" disabled={refreshing} onClick={refresh}><RefreshCw size={15}/>Обновить статус</button><button className="primary-button" data-testid="button-check-connection" disabled={checking} onClick={checkConnection}>{checking ? <Loader2 className="spin" size={16}/> : <Plug size={16}/>}Проверить и сохранить</button></div>
    </div> :
    <Form {...form}><form onSubmit={form.handleSubmit(async values => { if (saveTimer.current) clearTimeout(saveTimer.current); saveTimer.current = null; pendingSlider.current = null; setError(""); setSaved(false); await queueSettings({ ...values, contextManualDefaultsApplied: true }, ++sliderRevision.current); })} className="settings-form">
      {tab === "generation" ? <><div className="field"><label htmlFor="temperature">Творческий подход <span>{Number(form.watch("temperature")).toFixed(1)}</span></label><input id="temperature" data-testid="input-temperature" type="range" min="0" max="2" step="0.1" {...form.register("temperature", { valueAsNumber: true })}/><div className="range-labels"><span>Точнее</span><span>Креативнее</span></div></div><div className="field"><label htmlFor="context">Ручной размер контекста <span>{(Number(form.watch("context") ?? 262144) / 1024).toLocaleString("ru")}K токенов</span></label><input id="context" data-testid="slider-context-manual" type="range" min="2048" max="262144" step="1024" {...manualControl} onChange={e => { manualControl.onChange(e); saveSlider("context", Number(e.currentTarget.value)); }} onPointerUp={flushSlider} onKeyUp={flushSlider}/><div className="range-labels"><span>2K</span><span>256K</span></div><p className="field-hint">Настройка общая для всех чатов и сохраняется автоматически. Ручной размер применяется, когда шаг автоматического расширения равен 0. При включённом автоматическом расширении окно начинается с указанного шага, а не с 256K.</p></div>
      <div className="field"><label htmlFor="context-step">Загружать модель по достижении N токенов <span>{(Number(form.watch("contextStep") || 0) / 1024).toLocaleString("ru")}K</span></label><input id="context-step" data-testid="slider-context-step" type="range" min="0" max="32768" step="1024" {...stepControl} onChange={e => { stepControl.onChange(e); saveSlider("contextStep", Number(e.currentTarget.value)); }}/><div className="range-labels"><span>0 — выключено</span><span>32K</span></div><p className="field-hint">Шаг увеличения окна. Например, 8K → 16K → 24K → 32K … до 256K. При значении 0 сохраняется ручной размер контекста.</p></div>
      <div className="field"><label htmlFor="context-preload">Заранее загружать модель, если до лимита осталось N токенов <span>{(Number(form.watch("contextPreload") || 0) / 1024).toLocaleString("ru")}K</span></label><input id="context-preload" data-testid="slider-context-preload" type="range" min="0" max="16384" step="1024" disabled={Number(form.watch("contextStep")) === 0} {...preloadControl} onChange={e => { preloadControl.onChange(e); saveSlider("contextPreload", Number(e.currentTarget.value)); }}/><div className="range-labels"><span>0 — без упреждения</span><span>16K</span></div><p className="field-hint">Ollama заранее загрузит расширенное окно после завершения ответа. В режиме упреждения размер может удвоиться: 32K → 64K, 48K → 96K (максимум 256K). Для маленьких окон запас ограничен половиной окна.</p></div><div className="field"><label htmlFor="system">Инструкция для ассистента</label><textarea id="system" data-testid="input-system" rows={4} className="text-input" maxLength={12000} {...form.register("system")}/><p className="field-hint">Тон общения, язык и правила для всех новых ответов.</p></div></> : <div className="appearance-options">{[["light", "Светлая", Sun], ["dark", "Тёмная", Moon], ["system", "Как в системе", Monitor]].map(([id, label, Icon]: any) => <button type="button" key={id} data-testid={`theme-${id}`} className={`theme-option ${form.watch("theme") === id ? "chosen" : ""}`} onClick={() => { form.setValue("theme", id); setSaved(false); }}><div className={`theme-preview ${id}`}><div/><section><span/><span/><span/></section></div><div><Icon size={16}/>{label}{form.watch("theme") === id && <Check size={16}/>}</div></button>)}</div>}
      {error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions"><span className="saved-status" role="status">{saved && <><Check size={16}/>Изменения сохранены</>}</span><button type="submit" className="primary-button" data-testid="button-save-settings" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting && <Loader2 className="spin" size={16}/>}Сохранить настройки</button></div>
    </form></Form>}
  </DialogContent></Dialog>;
}

function AuthScreen() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const res = await apiRequest("POST", `/api/auth/${mode}`, { username, password });
      const data = await res.json();
      queryClient.removeQueries({ predicate: q => q.queryKey[0] !== "/api/auth/me" });
      queryClient.setQueryData(["/api/auth/me"], data);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
    <div style={{ width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}><Logo/><strong style={{ fontSize: 22 }}>forma.</strong></div>
      <h1 style={{ fontSize: 22, margin: 0 }}>{mode === "login" ? "Вход" : "Создать аккаунт"}</h1>
      <input className="text-input" aria-label="Имя" placeholder="Имя пользователя" autoComplete="username" data-testid="input-username" value={username} onChange={e => setUsername(e.target.value)}/>
      <input className="text-input" aria-label="Пароль" type="password" placeholder="Пароль (от 8 символов)" autoComplete={mode === "login" ? "current-password" : "new-password"} data-testid="input-password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === "Enter") submit(); }}/>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <button className="primary-button" data-testid="button-auth-submit" disabled={busy || !username.trim() || !password} onClick={submit}>{busy && <Loader2 className="spin" size={16}/>}{mode === "login" ? "Войти" : "Зарегистрироваться"}</button>
      <button className="secondary-button" data-testid="button-auth-switch" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "Нет аккаунта? Создать" : "Уже есть аккаунт? Войти"}</button>
    </div>
  </div>;
}
function AuthGate() {
  const me = useQuery<{ user: { id: string; username: string } | null }>({ queryKey: ["/api/auth/me"] });
  if (me.isLoading) return null;
  if (me.isError) return <div style={{ padding: 24 }}><p className="inline-error">{(me.error as Error).message}</p><button className="secondary-button" onClick={() => me.refetch()}>Повторить</button></div>;
  return me.data?.user ? <Workspace key={me.data.user.id} user={me.data.user}/> : <AuthScreen/>;
}
export default function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><Router hook={useHashLocation}><SidebarProvider style={{ "--sidebar-width": "264px" } as CSSProperties}><AuthGate/></SidebarProvider></Router></TooltipProvider></QueryClientProvider>;
}
