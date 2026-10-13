import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Monitor, ArrowUpRight, Play, Square, RefreshCw, Loader2, ShieldCheck, ChevronDown, Download, Check, Globe, Circle } from "lucide-react";
import { apiRequest, API_BASE, queryClient } from "@/lib/queryClient";

type Action = { id: string; tool: string; args: Record<string, unknown>; destination: string; target?: { text: string; type: string; href: string; tag: string }; form?: { action: string; method: string; fields: { name: string; value: string }[] } };
type Session = { id: string; model: string; task: string; status: string; events: { id: string; kind: string; text: string; time: number }[]; pending?: Action; screenshot?: string; url: string; title: string; steps: number; maxSteps: number; answer: string; error?: string };
type State = { enabled: boolean; browserInstalled: boolean; session: Session | null };
const labels: Record<string,string> = { running: "Выполняется", approval: "Нужно подтверждение", done: "Завершено", error: "Ошибка", stopped: "Остановлено" };
const tools: Record<string,string> = { navigate: "Открыть страницу", click: "Нажать элемент", fill: "Ввести текст", press: "Нажать клавишу", scroll: "Прокрутить", read_page: "Прочитать страницу" };

export default function Computer({ models, model, connected, connect }: { models: { name: string }[]; model: string; connected: boolean; connect: () => void }) {
  const [task, setTask] = useState(""), [selected, setSelected] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const state = useQuery<State>({ queryKey: ["/api/computer"], refetchInterval: 1500 });
  const session = state.data?.session, pending = session?.pending;
  useEffect(() => { if (session) { setTask(session.task); setSelected(session.model); } }, [session?.id]);
  const active = session && ["running", "approval"].includes(session.status);
  const chosen = selected || (models.some(m => m.name === model) ? model : models[0]?.name) || "";
  async function action(path: string, data: unknown = {}) {
    setBusy(true); setError("");
    try { await apiRequest("POST", path, data); await queryClient.invalidateQueries({ queryKey: ["/api/computer"] }); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <div className="computer-page">
    <div className="computer-heading"><div><div className="eyebrow">FORMA WORKSPACE</div><h1>Computer<span>beta</span></h1></div><div className="computer-heading-actions">{session && <a className="secondary-button" data-testid="button-computer-export" href={`${API_BASE}/api/computer/export`} target="_blank" rel="noopener noreferrer"><Download size={16}/>Журнал</a>}<button className="secondary-button" data-testid="button-computer-refresh" onClick={() => state.refetch()}><RefreshCw size={16}/></button></div></div>
    {state.isError && <p className="inline-error" role="alert">{(state.error as Error).message}</p>}
    {state.data && !state.data.enabled && <div className="connection-banner"><Monitor size={20}/><div><strong>Откройте локальную версию</strong><p>В облачном превью выполнение отключено. Полный проект содержит сервер Computer.</p></div></div>}
    {state.data?.enabled && !connected && <div className="connection-banner"><Globe size={20}/><div><strong>Сначала подключите Ollama</strong><p>Используйте уже установленные модели.</p></div><button data-testid="button-computer-connect" onClick={connect}>Подключить<ArrowUpRight size={15}/></button></div>}
    {state.data?.enabled && !state.data.browserInstalled && <div className="computer-install"><Monitor size={19}/><span>Подготовить браузер: <code>npm run setup:computer</code></span></div>}
    <div className="computer-grid">
      <section className="computer-task-panel">
        <label className="field-label" htmlFor="computer-task">Задача</label>
        <textarea id="computer-task" data-testid="input-computer-task" className="text-input" rows={5} maxLength={12000} placeholder="Например: открой сайт и найди нужную информацию…" value={task} disabled={!!active} onChange={e => setTask(e.target.value)}/>
        <label className="field-label computer-model-label" htmlFor="computer-model">Модель Ollama</label>
        <select id="computer-model" data-testid="select-computer-model" className="text-input" value={chosen} disabled={!!active} onChange={e => setSelected(e.target.value)}>{!models.length && <option value="">Нет подключённых моделей</option>}{models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}</select>
        <p className="field-hint">Нужна модель с поддержкой tools.</p>
        <div className="computer-launch">{active ? <button className="primary-button" data-testid="button-computer-stop" disabled={busy} onClick={() => action("/api/computer/stop")}><Square size={15}/>Остановить</button> : <button className="primary-button" data-testid="button-computer-start" disabled={busy || !task.trim() || !chosen || !connected || !state.data?.enabled} onClick={() => action("/api/computer/start", { task, model: chosen })}>{busy ? <Loader2 size={15} className="spin"/> : <Play size={15}/>}Запустить</button>}<span className="computer-step-count">{session && `${session.steps} / ${session.maxSteps} шагов`}</span></div>
        {error && <p className="inline-error" data-testid="error-computer" role="alert">{error}</p>}
        {pending && <div className="computer-approval" data-testid="card-computer-approval"><div className="approval-heading"><ShieldCheck size={19}/><h2>Подтвердить действие</h2></div><dl><dt>Действие</dt><dd>{tools[pending.tool] || pending.tool}</dd><dt>Сайт</dt><dd>{pending.destination}</dd>{pending.target && <><dt>Элемент</dt><dd>{pending.target.text || pending.target.tag}{pending.target.href && <small>{pending.target.href}</small>}</dd></>}{pending.args.text !== undefined && <><dt>Точный текст</dt><dd className="approval-payload">{String(pending.args.text)}</dd></>}{pending.args.key !== undefined && <><dt>Клавиша</dt><dd>{String(pending.args.key)}</dd></>}{pending.form && <><dt>Форма: {pending.form.method.toUpperCase()}</dt><dd>{pending.form.action}</dd><dt>Поля формы</dt><dd className="approval-payload">{JSON.stringify(pending.form.fields, null, 2)}</dd></>}</dl><p>Выполнить только это действие? Ввод текста может передать его сайту ещё до отправки формы.</p><div className="dialog-actions"><button className="secondary-button" data-testid="button-computer-reject" disabled={busy} onClick={() => action("/api/computer/approval", { sessionId: session.id, actionId: pending.id, approved: false })}>Отклонить</button><button className="primary-button" data-testid="button-computer-approve" disabled={busy} onClick={() => action("/api/computer/approval", { sessionId: session.id, actionId: pending.id, approved: true })}><Check size={15}/>Разрешить</button></div></div>}
        <div className="computer-journal"><div className="computer-journal-heading"><h2>Ход работы</h2>{session && <span className={`run-state ${session.status}`} data-testid="status-computer">{labels[session.status]}</span>}</div>{session?.events.length ? <ol>{session.events.map(e => <li key={e.id} data-testid={`computer-event-${e.id}`}><span className={`event-dot ${e.kind}`}/><div><small>{new Date(e.time).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })}</small><p>{e.text}</p></div></li>)}</ol> : <p className="field-hint">Здесь появятся шаги текущей задачи.</p>}</div>
      </section>
      <section className="computer-browser-panel">
        <div className="computer-browser-chrome"><div className="window-dots"><i/><i/><i/></div><div className="browser-url"><Globe size={14}/><span data-testid="text-computer-url">{session?.url && session.url !== "about:blank" ? session.url : "Новая вкладка"}</span></div><span className="browser-size">1280 × 800</span></div>
        <div className="computer-screen">{session?.screenshot && session.url !== "about:blank" ? <img src={session.screenshot} width={1280} height={800} alt={`Страница отдельного браузера: ${session.title || session.url}`} data-testid="img-computer-browser"/> : <div className="computer-browser-empty"><Monitor size={46} strokeWidth={1.3}/><h2>Отдельный браузер</h2><p>{active ? "Модель планирует первый шаг." : "Запустите задачу, чтобы открыть рабочую сессию."}</p></div>}</div>
        <div className="computer-browser-footer"><ShieldCheck size={14}/><span>Отдельная сессия · без доступа к вашему основному браузеру</span>{active && <Loader2 size={14} className="spin"/>}</div>
        {session?.answer && <div className="computer-result" data-testid="text-computer-result"><h2>Результат</h2><p>{session.answer}</p></div>}
        {session?.error && <div className="computer-result error-result" role="alert"><h2>Задача приостановлена</h2><p>{session.error}</p></div>}
      </section>
    </div>
  </div>;
}
