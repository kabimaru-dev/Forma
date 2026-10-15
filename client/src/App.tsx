import { useState, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Plus, Search, Box, Settings2, ArrowUp, ArrowUpRight, ChevronDown, ChevronRight, PanelLeftClose, PanelLeft, Sun, Moon, CircleHelp, MessageSquare, SlidersHorizontal, Paperclip, X, FileText, Pencil, Code2, Lightbulb, GraduationCap, ArrowRight, Download, RefreshCw, Check, Copy, Trash2, Ellipsis, Monitor, Plug, Square, Loader2, ExternalLink, CheckCircle2, Circle, LockKeyhole, LogOut } from "lucide-react";
import { Sidebar, SidebarProvider, SidebarContent, SidebarFooter, SidebarHeader, useSidebar } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Form } from "@/components/ui/form";
import { queryClient, apiRequest, API_BASE } from "@/lib/queryClient";
import type { Settings, Chat, Message } from "@shared/schema";
import { defaultSettings } from "@shared/defaults";
import Computer from "./Computer";

type Model = { name: string; size: number; remote_host?: string; details?: { parameter_size?: string; quantization_level?: string; family?: string } };
type Status = { connected: boolean; host: string; models: Model[]; backend?: boolean; message?: string; editable?: boolean; preview?: boolean };
type ChatSummary = Omit<Chat, "owner" | "messages"> & { preview: string; count: number };

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
  const isModels = location === "/models";
  const isComputer = location === "/computer";
  const { open, toggleSidebar, setOpenMobile, isMobile } = useSidebar();
  const settingsQuery = useQuery<Settings>({ queryKey: ["/api/settings"] });
  const settings = settingsQuery.data || defaultSettings;
  const statusQuery = useQuery<Status>({ queryKey: ["/api/status"], refetchInterval: 30000 });
  const status: Status | undefined = statusQuery.isError ? { connected: false, backend: false, host: "", models: [], editable: false, message: (statusQuery.error as Error).message } : statusQuery.data;
  const chatsQuery = useQuery<ChatSummary[]>({ queryKey: ["/api/chats"] });
  const chats = chatsQuery.data || [];
  const chatQuery = useQuery<Chat>({ queryKey: ["/api/chats", chatId || ""], enabled: !!chatId });
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<{ name: string; text: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("connection");
  const [helpOpen, setHelpOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [modelMenu, setModelMenu] = useState(false);
  const [chatMenu, setChatMenu] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
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
  const model = selected || chatQuery.data?.model || settings.model || models[0]?.name || "";
  const current = chats.find(c => c.id === chatId);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [editedMessages, setEditedMessages] = useState<Record<string, string>>({});

  const displayMessages = messages.map((m) =>
    editedMessages[m.id]
      ? { ...m, content: editedMessages[m.id] }
      : m
  );

  const startEdit = (m: any) => {
    setEditingId(m.id);
    setDraft(m.content ?? "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
  };

  const saveEdit = (m: any) => {
    const text = draft.trim();
    if (!text) return;

    setEditedMessages((prev) => ({
      ...prev,
      [m.id]: text,
    }));

    setEditingId(null);
    setDraft("");
  };


  useEffect(() => {
    if (settingsQuery.data) {
      const next = settings.theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : settings.theme;
      setTheme(next);
    }
  }, [settings.theme, settingsQuery.data]);
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle("dark", theme === "dark"); }, [theme]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => { if (settings.theme === "system") setTheme(media.matches ? "dark" : "light"); };
    media.addEventListener("change", update); return () => media.removeEventListener("change", update);
  }, [settings.theme]);
  useEffect(() => { setError(""); setSelected(""); setDraft(""); setAttachment(null); setOpenMobile(false); }, [location]);
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
    location.hash = "#/";
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
  async function chooseModel(name: string) {
    setSelected(name); setModelMenu(false);
    try { await saveSettings({ ...settings, model: name }); } catch { setNotice("Модель выбрана только для текущего сеанса."); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice("Скопировано"); }
    catch { setNotice("Браузер не разрешил копирование. Выделите текст вручную."); }
  }
  async function attach(file: File | undefined) {
    if (!file) return;
    if (file.size > 100000) { setError("Прикрепите текстовый файл до 100 КБ."); return; }
    if (!/\.(txt|md|csv|json|js|ts|tsx|jsx|py|html|css|yml|yaml|log)$/i.test(file.name)) { setError("Поддерживаются текстовые файлы, Markdown, CSV, JSON и исходный код."); return; }
    const text = await file.text();
    if (text.includes("\0")) { setError("Этот файл содержит бинарные данные. Выберите текстовый файл."); return; }
    setAttachment({ name: file.name, text }); setError("");
    if (fileInput.current) fileInput.current.value = "";
  }
  async function send(retry = false) {
    if (busy || (!retry && !draft.trim() && !attachment)) return;
    if (!status?.connected) { setError("Сначала подключите Ollama. Ваш текст останется здесь."); openSettings(); return; }
    if (!model || !models.some(m => m.name === model)) { setError("Выберите установленную модель во вкладке «Модели»."); setModelMenu(true); return; }
    const content = `${draft.trim()}${attachment ? `\n\nФайл: ${attachment.name}\n\`\`\`\n${attachment.text}\n\`\`\`` : ""}`.trim();
    if (content.length > 100000) { setError("Сообщение вместе с файлом должно быть короче 100 000 символов."); return; }
    setError(""); setBusy(true);
    let id = chatId;
    const aborter = new AbortController(); controller.current = aborter;
    try {
      if (!id) {
        const res = await apiRequest("POST", "/api/chats", { title: draft.trim().slice(0, 65) || attachment?.name || "Новый диалог", model });
        const created = await res.json(); id = created.id; navigate(`/chat/${id}`);
      }
      const activeId = id!;
      let history = [...(chatQuery.data?.messages || [])];
      if (retry) { while (history.at(-1)?.role === "assistant") history.pop(); }
      else history.push({ id: "pending-user", role: "user", content });
      const assistantId = "stream-assistant";
      setLive({ id: activeId, messages: [...history, { id: assistantId, role: "assistant", content: "", model }] });
      setDraft(""); setAttachment(null);
      await queryClient.invalidateQueries({ queryKey: ["/api/chats"], exact: true });
      const response = await apiRequest("POST", `/api/chats/${id}/send`, { content, model, retry }, aborter.signal);
      await readStream(response, event => {
        if (event.type === "token") setLive(prev => prev && ({ ...prev, messages: prev.messages.map(m => m.id === assistantId ? { ...m, content: m.content + event.content } : m) }));
        if (event.type === "error") setError(event.message);
      });
    } catch (e: any) {
      if (e.name !== "AbortError") setError(e.message || "Не удалось отправить сообщение.");
      else setNotice("Генерация остановлена");
    } finally {
      if (aborter.signal.aborted && id) {
        try { await apiRequest("POST", `/api/chats/${id}/stop`, {}); } catch {}
      }
      if (id) await queryClient.invalidateQueries({ queryKey: ["/api/chats", id] });
      await queryClient.invalidateQueries({ queryKey: ["/api/chats"], exact: true });
      setBusy(false); setLive(null); controller.current = null;
    }
  }
  const picker = <Popover open={modelMenu} onOpenChange={setModelMenu}>
    <PopoverTrigger asChild><button className="model-picker" disabled={busy} data-testid="button-model-picker"><Box size={16} /><span>{model || "Выбрать модель"}</span><ChevronDown size={14} /></button></PopoverTrigger>
    <PopoverContent className="model-popover" align="start"><div className="popover-label">МОДЕЛИ OLLAMA</div>{models.length ? models.map(m => <button key={m.name} data-testid={`select-model-${m.name}`} className="model-option" onClick={() => chooseModel(m.name)}><Box size={17}/><span>{m.name}<small>{m.remote_host ? "Облачная модель" : `${m.details?.parameter_size || "Локальная модель"} · ${(m.size / 1e9).toFixed(1)} ГБ`}</small></span>{m.name === model && <Check size={16}/>}</button>) : <p className="popover-empty">Подключите Ollama и загрузите первую модель.</p>}<button className="popover-footer" data-testid="button-manage-models" onClick={() => { setModelMenu(false); navigate("/models"); }}><Plus size={16}/> Управление моделями<ArrowUpRight size={15}/></button></PopoverContent>
  </Popover>;
  const composer = <div className="composer-wrap">
    <div className={`composer ${busy ? "generating" : ""}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); attach(e.dataTransfer.files[0]); }}>
      {attachment && <div className="attachment" data-testid="text-attachment"><FileText size={15}/><span>{attachment.name}</span><IconButton label="Убрать файл" onClick={() => setAttachment(null)}><X size={14}/></IconButton></div>}
      <textarea ref={textarea} aria-label="Сообщение" data-testid="input-message" value={draft} onChange={e => { setDraft(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`; }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} placeholder="Спросите о чём угодно или поделитесь идеей…" rows={2}/>
      <div className="composer-tools"><div className="flex items-center gap-1"><IconButton label="Прикрепить текстовый файл" testid="button-attach" onClick={() => fileInput.current?.click()} disabled={busy}><Paperclip size={19}/></IconButton><span className="tool-separator"/>{picker}</div><div className="flex items-center gap-2"><IconButton label="Параметры ответа" testid="button-generation-settings" onClick={() => openSettings("generation")}><SlidersHorizontal size={18}/></IconButton>{busy ? <button className="send-button stop" aria-label="Остановить ответ" data-testid="button-stop" onClick={() => controller.current?.abort()}><Square size={17} fill="currentColor"/></button> : <button className="send-button" aria-label="Отправить сообщение" data-testid="button-send" disabled={!draft.trim() && !attachment} onClick={() => send()}><ArrowUp size={21}/></button>}</div></div>
    </div>
    <input ref={fileInput} type="file" className="hidden" aria-label="Текстовый файл" data-testid="input-file" accept=".txt,.md,.csv,.json,.js,.ts,.tsx,.jsx,.py,.html,.css,.yml,.yaml,.log" onChange={e => attach(e.target.files?.[0])}/>
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
          <button className={isModels ? "active" : ""} data-testid="button-models" onClick={() => navigate("/models")}><Box size={18}/><span>Модели</span><ArrowUpRight className="nav-arrow" size={15}/></button>
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
          <p>{status?.connected ? `${models.length} моделей доступно в Ollama` : "Подключите локальные модели и начните разговор."}</p>
          <span className="connect-link">{status?.connected ? "Ollama подключена" : "Подключить Ollama"}<ArrowRight size={14}/></span>
        </button>
        <div className="side-footer-links"><button data-testid="button-help" onClick={() => { setOpenMobile(false); setHelpOpen(true); }}><CircleHelp size={17}/>Как это работает</button><button data-testid="button-settings" onClick={() => { setOpenMobile(false); openSettings(); }}><Settings2 size={17}/>Настройки</button></div>
        <div className="profile"><span className="profile-avatar">{user.username.slice(0, 1).toUpperCase()}</span><div>{user.username}<small>Личный аккаунт</small></div><IconButton label="Выйти" testid="button-logout" onClick={logout}><LogOut size={17}/></IconButton><IconButton label={theme === "light" ? "Тёмная тема" : "Светлая тема"} testid="button-theme-sidebar" onClick={changeTheme}>{theme === "light" ? <Moon size={17}/> : <Sun size={17}/>}</IconButton></div>
      </SidebarFooter>
    </Sidebar>
    <main className="main-panel">
      <header className="topbar"><div className="topbar-left">{(!open || isMobile) && <IconButton label="Открыть меню" testid="button-open-sidebar" onClick={toggleSidebar}><PanelLeft size={19}/></IconButton>}<span className="page-breadcrumb">Личное пространство</span><ChevronRight className="breadcrumb-chevron" size={13}/><span className="page-name">{isComputer ? "Computer" : isModels ? "Модели" : current?.title || "Новый диалог"}</span></div><div className="topbar-right"><button className={`connection-status ${status?.connected ? "online" : ""}`} data-testid="status-connection" onClick={() => openSettings()}><span className="status-dot"/><span>{statusQuery.isFetching && !status ? "Проверяем Ollama" : status?.backend === false ? "Сервер Forma недоступен" : status?.connected ? "Ollama подключена" : "Ollama не подключена"}</span></button><span className="topbar-divider"/><IconButton label={theme === "light" ? "Тёмная тема" : "Светлая тема"} testid="button-theme" onClick={changeTheme}>{theme === "light" ? <Moon size={18}/> : <Sun size={18}/>}</IconButton></div></header>
      {isComputer ? <Computer models={models} model={model} connected={!!status?.connected} connect={() => openSettings()}/> : isModels ? <ModelsView status={status} refreshing={statusQuery.isFetching} refresh={() => statusQuery.refetch()} select={name => { chooseModel(name); navigate("/"); }} connect={() => openSettings()} /> : chatId ? <>
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
                        <small>{m.model}</small>
                      </div>
                    )}

                    <div className="message-body">
                      {isEditing ? (
                        <form
                          className="message-edit-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            saveEdit(m);
                          }}
                        >
                          <textarea
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            rows={Math.max(2, Math.min(10, draft.split("\n").length + 1))}
                          />
                          <div className="message-edit-actions">
                            <button type="submit">Сохранить</button>
                            <button type="button" onClick={cancelEdit}>
                              Отмена
                            </button>
                          </div>
                        </form>
                      ) : m.content ? (
                        <Markdown text={m.content} copy={copy} />
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
                      <small className="interrupted">Ответ был остановлен</small>
                    )}

                    <div className="message-actions">
                      <IconButton
                        label="Копировать сообщение"
                        testid={`copy-message-${i}`}
                        onClick={() => copy(m.content)}
                      >
                        <Copy size={15} />
                      </IconButton>

                      {m.content && (
                        <IconButton
                          label="Изменить сообщение"
                          testid={`edit-message-${i}`}
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
    <SettingsDialog open={settingsOpen} setOpen={setSettingsOpen} tab={settingsTab} setTab={setSettingsTab} settings={settings} save={saveSettings} status={status} refreshing={statusQuery.isFetching} refresh={() => statusQuery.refetch()} models={() => { setSettingsOpen(false); navigate("/models"); }} />
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}><DialogContent className="app-dialog help-dialog"><DialogHeader><DialogTitle>Знакомьтесь, Forma</DialogTitle><DialogDescription>Знакомый чат. Модели, которые выбираете вы.</DialogDescription></DialogHeader><div className="help-content"><div className="help-step"><span>01</span><div><h3>Запустите Ollama</h3><p>Установите Ollama на свой компьютер и откройте приложение. Сервер Forma должен работать на том же компьютере или иметь доступ к вашей Ollama.</p><a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" data-testid="link-ollama-download">Скачать Ollama<ExternalLink size={14}/></a></div></div><div className="help-step"><span>02</span><div><h3>Добавьте свою модель</h3><p>Откройте «Модели», вставьте имя из библиотеки Ollama и нажмите «Загрузить». Файлы загрузятся на компьютер с Ollama.</p></div></div><div className="help-step"><span>03</span><div><h3>Начните разговор</h3><p>Выберите модель, напишите сообщение или прикрепите текстовый файл. История сохраняется в базе на сервере Forma.</p></div></div><div className="shortcuts"><span>Отправить <kbd>Enter</kbd></span><span>Новая строка <kbd>Shift + Enter</kbd></span><span>Поиск <kbd>Ctrl / ⌘ K</kbd></span></div></div></DialogContent></Dialog>
    <Dialog open={searchOpen} onOpenChange={setSearchOpen}><DialogContent className="app-dialog search-dialog"><DialogHeader><DialogTitle>Найти диалог</DialogTitle><DialogDescription>По названию или тексту сообщений</DialogDescription></DialogHeader><div className="search-input"><Search size={19}/><input autoFocus aria-label="Поиск диалогов" placeholder="О чём мы говорили?" data-testid="input-search" value={search} onChange={e => setSearch(e.target.value)}/></div><div className="search-results">{chats.filter(c => `${c.title} ${c.preview}`.toLowerCase().includes(search.toLowerCase())).map(c => <button key={c.id} data-testid={`search-result-${c.id}`} onClick={() => { navigate(`/chat/${c.id}`); setSearchOpen(false); }}><MessageSquare size={18}/><span>{c.title}<small>{c.preview.slice(0, 85) || "Пока без сообщений"}</small></span><ArrowUpRight size={16}/></button>)}{!chats.filter(c => `${c.title} ${c.preview}`.toLowerCase().includes(search.toLowerCase())).length && <div className="search-empty"><Search size={25}/><p>{search ? "Такого диалога пока нет" : "Ваши диалоги появятся здесь"}</p><small>{search ? "Попробуйте другое слово." : "Начните новый чат, и мы сохраним его для вас."}</small></div>}</div></DialogContent></Dialog>
    <Dialog open={!!rename} onOpenChange={v => { if (!v) setRename(null); }}><DialogContent className="app-dialog compact-dialog"><DialogHeader><DialogTitle>Название диалога</DialogTitle><DialogDescription>Так его будет проще найти в истории.</DialogDescription></DialogHeader><input className="text-input" aria-label="Название" value={renameText} onChange={e => setRenameText(e.target.value)} data-testid="input-rename" maxLength={120}/>{modalError && <p className="inline-error" role="alert">{modalError}</p>}<button className="primary-button" data-testid="button-save-rename" disabled={!renameText.trim() || operation} onClick={async () => { setOperation(true); try { await apiRequest("PATCH", `/api/chats/${rename!.id}`, { title: renameText }); await queryClient.invalidateQueries({ queryKey: ["/api/chats"] }); setRename(null); } catch(e: any) { setModalError(e.message); } finally { setOperation(false); } }}>Сохранить</button></DialogContent></Dialog>
    <Dialog open={!!deleteChat} onOpenChange={v => { if (!v) setDeleteChat(null); }}><DialogContent className="app-dialog compact-dialog"><DialogHeader><DialogTitle>Удалить диалог?</DialogTitle><DialogDescription>«{deleteChat?.title}» и все его сообщения будут удалены без возможности восстановления.</DialogDescription></DialogHeader>{modalError && <p role="alert" className="inline-error">{modalError}</p>}<div className="dialog-actions"><button className="secondary-button" data-testid="button-cancel-delete" onClick={() => setDeleteChat(null)}>Оставить</button><button className="primary-button danger" data-testid="button-confirm-delete" disabled={operation} onClick={async () => { setOperation(true); try { await apiRequest("DELETE", `/api/chats/${deleteChat!.id}`); if (chatId === deleteChat!.id) newChat(); await queryClient.invalidateQueries({ queryKey: ["/api/chats"] }); setDeleteChat(null); } catch(e: any) { setModalError(e.message); } finally { setOperation(false); } }}>Удалить диалог</button></div></DialogContent></Dialog>
    {notice && <div className="notice" role="status" data-testid="status-notice"><CheckCircle2 size={16}/>{notice}</div>}
  </div>;
}

function SettingsDialog({ open, setOpen, tab, setTab, settings, save, status, refreshing, refresh, models }: { open: boolean; setOpen: (v: boolean) => void; tab: string; setTab: (v: string) => void; settings: Settings; save: (s: Settings) => Promise<void>; status?: Status; refreshing: boolean; refresh: () => void; models: () => void }) {
  const form = useForm<Settings>({ defaultValues: settings });
  const [saved, setSaved] = useState(false), [error, setError] = useState("");
  const [host, setHost] = useState(""), [checking, setChecking] = useState(false), [connection, setConnection] = useState<Status | null>(null);
  useEffect(() => { if (open) { form.reset(settings); setSaved(false); setError(""); setConnection(null); setHost(settings.ollamaUrl || status?.host || "http://127.0.0.1:11434"); } }, [open]);
  async function checkConnection() {
    setChecking(true); setError(""); setConnection(null);
    try {
      const response = await apiRequest("POST", "/api/connection", { url: host });
      const result = await response.json();
      setConnection(result);
      if (result.connected) {
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
      <div className={`connection-box ${shown?.connected ? "connected" : ""}`}><span className="connection-large">{shown?.connected ? <CheckCircle2 size={23}/> : <Plug size={23}/>}</span><div><h3>{shown?.backend === false ? "Не запущен сервер Forma" : shown?.connected ? "Ollama на связи" : "Подключение к Ollama"}</h3><p>{shown?.connected ? `Доступно моделей: ${shown.models.length}` : shown?.backend === false ? "Один фронтенд не подключается к Ollama." : "Укажите адрес уже работающей Ollama."}</p></div><span className={`status-dot ${shown?.connected ? "green" : ""}`}/></div>
      <label className="field-label" htmlFor="ollama-url">Адрес вашей Ollama</label>
      <div className="host-field editable-host"><Monitor size={17}/><input id="ollama-url" data-testid="input-ollama-url" value={host} disabled={checking} onChange={e => { setHost(e.target.value); setConnection(null); }} placeholder="http://127.0.0.1:11434" onKeyDown={e => { if (e.key === "Enter" && !status?.preview) checkConnection(); }}/></div>
      <p className="field-hint">Изменения сохраняются после успешной проверки. Перезапуск не нужен.</p>
      {shown?.message && <div className={`connection-feedback ${shown.connected ? "success" : ""}`} role="status" data-testid="status-connection-details">{shown.message}</div>}
      {error && <p className="inline-error" role="alert" data-testid="error-connection">{error}</p>}
      
      
      <div className="dialog-actions"><button className="secondary-button" data-testid="button-refresh-backend" disabled={refreshing} onClick={refresh}><RefreshCw size={15}/>Обновить статус</button><button className="primary-button" data-testid="button-check-connection" disabled={checking} onClick={checkConnection}>{checking ? <Loader2 className="spin" size={16}/> : <Plug size={16}/>}Проверить и сохранить</button></div>
      {shown?.connected && <button className="connection-models-link" data-testid="button-connected-models" onClick={models}>Открыть установленные модели<ArrowRight size={15}/></button>}
    </div> :
    <Form {...form}><form onSubmit={form.handleSubmit(async values => { try { setError(""); await save(values); setSaved(true); } catch (e: any) { setError(e.message); } })} className="settings-form">
      {tab === "generation" ? <><div className="field"><label htmlFor="temperature">Творческий подход <span>{Number(form.watch("temperature")).toFixed(1)}</span></label><input id="temperature" data-testid="input-temperature" type="range" min="0" max="2" step="0.1" {...form.register("temperature", { valueAsNumber: true })}/><div className="range-labels"><span>Точнее</span><span>Креативнее</span></div></div><div className="field"><label htmlFor="context">Размер контекста</label><select id="context" className="text-input" data-testid="select-context" {...form.register("context", { valueAsNumber: true })}>{[2048, 4096, 8192, 16384, 32768].map(n => <option key={n} value={n}>{n.toLocaleString("ru")} токенов</option>)}</select><p className="field-hint">Большой контекст требует больше оперативной памяти. Фактический предел зависит от модели.</p></div><div className="field"><label htmlFor="system">Инструкция для ассистента</label><textarea id="system" data-testid="input-system" rows={4} className="text-input" maxLength={12000} {...form.register("system")}/><p className="field-hint">Тон общения, язык и правила для всех новых ответов.</p></div></> : <div className="appearance-options">{[["light", "Светлая", Sun], ["dark", "Тёмная", Moon], ["system", "Как в системе", Monitor]].map(([id, label, Icon]: any) => <button type="button" key={id} data-testid={`theme-${id}`} className={`theme-option ${form.watch("theme") === id ? "chosen" : ""}`} onClick={() => { form.setValue("theme", id); setSaved(false); }}><div className={`theme-preview ${id}`}><div/><section><span/><span/><span/></section></div><div><Icon size={16}/>{label}{form.watch("theme") === id && <Check size={16}/>}</div></button>)}</div>}
      {error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions"><span className="saved-status" role="status">{saved && <><Check size={16}/>Изменения сохранены</>}</span><button type="submit" className="primary-button" data-testid="button-save-settings" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting && <Loader2 className="spin" size={16}/>}Сохранить настройки</button></div>
    </form></Form>}
  </DialogContent></Dialog>;
}

function ModelsView({ status, refresh, refreshing, select, connect }: { status?: Status; refresh: () => void; refreshing: boolean; select: (name: string) => void; connect: () => void }) {
  const [name, setName] = useState("");
  const [pulling, setPulling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [pullStatus, setPullStatus] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function pull() {
    if (!name.trim() || pulling) return;
    if (!status?.connected) { setError("Сначала подключите Ollama, затем запустите загрузку."); return; }
    setPulling(true); setError(""); setDone(false); setProgress(0); setPullStatus("Подключаемся к библиотеке…");
    const controller = new AbortController(); abort.current = controller;
    let success = false;
    try {
      const response = await apiRequest("POST", "/api/models/pull", { model: name.trim() }, controller.signal);
      await readStream(response, event => {
        if (event.error) throw new Error(event.error);
        if (event.total && event.completed !== undefined) setProgress(Math.round(event.completed / event.total * 100));
        setPullStatus(event.status === "success" ? "Модель готова к работе" : event.total ? "Загружаем файлы модели" : event.status || "Подготовка модели");
        if (event.status === "success") { success = true; setDone(true); setProgress(100); }
      });
      if (!success) throw new Error("Загрузка прервалась. Попробуйте снова: Ollama использует уже скачанные файлы.");
      refresh();
    } catch(e: any) { setError(e.name === "AbortError" ? "Ожидание отменено. Проверьте список моделей перед повторной загрузкой." : e.message); }
    finally { setPulling(false); abort.current = null; }
  }
  return <div className="models-page"><div className="models-heading"><div className="eyebrow">ВАШ ЛИЧНЫЙ НАБОР AI</div><div className="section-title"><h1>Модели</h1><button className="secondary-button" data-testid="button-refresh-models" disabled={refreshing} onClick={refresh}><RefreshCw className={refreshing ? "spin" : ""} size={16}/>Обновить</button></div><p>Выберите, с кем вы хотите поговорить.</p></div>
    {!status?.connected && <div className="connection-banner"><Plug size={20}/><div><strong>Нужна связь с Ollama</strong><p>Подключите сервер, чтобы увидеть и загрузить модели.</p></div><button data-testid="button-models-connect" onClick={connect}>Подключить<ArrowRight size={15}/></button></div>}
    <section className="install-section"><div className="install-heading"><Download size={21}/><div><h2>Добавить модель</h2><p>Вставьте имя модели из библиотеки Ollama.</p></div><a href="https://ollama.com/library" data-testid="link-model-library" target="_blank" rel="noopener noreferrer">Открыть библиотеку<ArrowUpRight size={15}/></a></div><div className="install-input-row"><input aria-label="Имя модели" className="text-input" placeholder="имя-модели:тег" data-testid="input-model-name" value={name} disabled={pulling} onChange={e => { setName(e.target.value); setDone(false); }} onKeyDown={e => { if (e.key === "Enter") pull(); }}/>{pulling ? <button className="secondary-button" data-testid="button-cancel-pull" onClick={() => abort.current?.abort()}><Square size={15}/>Отменить</button> : <button className="primary-button" data-testid="button-pull-model" onClick={pull} disabled={!name.trim()}><Download size={16}/>Загрузить</button>}</div><p className="field-hint">Файлы сохранятся на компьютере с Ollama. Размер и требования к памяти зависят от выбранной модели.</p>{(pulling || done) && <div className="download-progress" role="status" data-testid="status-pull"><div><span>{pullStatus}</span><span>{progress}%</span></div><progress value={progress} max={100}/></div>}{error && <p className="inline-error" role="alert" data-testid="error-pull">{error}</p>}</section>
    <div className="models-list-heading"><h2>Установленные модели</h2><span>{status?.models.length || 0}</span></div>
    {status?.connected && <p className="existing-models-hint">Модели уже установлены в вашей Ollama. Нажмите «Начать чат» без повторной загрузки.</p>}
    {status?.models.length ? <div className="model-list">{status.models.map(m => <article className="model-card" key={m.name}><div className="model-symbol"><Box size={24}/></div><div><h3>{m.name}</h3><p>{m.remote_host ? "Облачная модель" : `${(m.size / 1e9).toFixed(1)} ГБ`}{m.details?.parameter_size && ` · ${m.details.parameter_size}`}{m.details?.quantization_level && ` · ${m.details.quantization_level}`}</p></div><button className="secondary-button" data-testid={`button-use-${m.name}`} onClick={() => select(m.name)}>Начать чат<ArrowRight size={15}/></button></article>)}</div> : <div className="models-empty"><Box size={34} strokeWidth={1.3}/><h3>Место для вашей первой модели</h3><p>После загрузки она появится здесь.<br/>Вы сможете выбирать её в любом диалоге.</p></div>}
    <div className="model-footnote"><LockKeyhole size={16}/><p>Локальные модели работают на вашем оборудовании. Облачные модели Ollama обрабатывают запросы на стороне провайдера.</p></div>
  </div>;
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
