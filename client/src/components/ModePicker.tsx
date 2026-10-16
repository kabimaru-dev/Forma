import { useState } from "react";
import { Box, Check, ChevronDown, ChevronLeft, ChevronRight, Gauge, SlidersHorizontal, Sparkles } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

export const LEVELS = ["core", "plus", "pro", "ultra"] as const;
export const REASONING = ["low", "medium", "high", "extra_high", "max"] as const;
export const SPEEDS = ["normal", "fast"] as const;
export type Level = typeof LEVELS[number];
export type Reasoning = typeof REASONING[number];
export type Speed = typeof SPEEDS[number];
export type ModeSelection = { level: Level; reasoning: Reasoning; speed: Speed };
export type ModesPublic = { levels: Record<Level, boolean>; available: Record<Level, Record<Reasoning, Record<Speed, boolean>>> };

export const LEVEL_NAMES: Record<Level, string> = { core: "Core", plus: "Plus", pro: "Pro", ultra: "Ultra" };
export const REASONING_NAMES: Record<Reasoning, string> = { low: "Low", medium: "Medium", high: "High", extra_high: "Extra High", max: "Max" };
export const SPEED_NAMES: Record<Speed, string> = { normal: "Normal", fast: "Fast" };
export function modeId(selection: ModeSelection) { return `forma:${selection.level}:${selection.reasoning}:${selection.speed}`; }
export function readableMode(id?: string): string {
  const match = /^forma:(core|plus|pro|ultra):(low|medium|high|extra_high|max):(normal|fast)$/.exec(id || "");
  return match ? `Forma · ${LEVEL_NAMES[match[1] as Level]} · ${REASONING_NAMES[match[2] as Reasoning]}` : (id || "Forma");
}

type Props = {
  manual: boolean;
  selection: ModeSelection;
  available?: ModesPublic;
  models: { name: string; size: number }[];
  manualModel: string;
  disabled: boolean;
  onSelection: (next: ModeSelection) => void;
  onManual: (model: string) => void;
  onPreset: () => void;
  onManage: () => void;
};

export default function ModePicker({ manual, selection, available, models, manualModel, disabled, onSelection, onManual, onPreset, onManage }: Props) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"presets" | "custom" | "levels" | "reasoning" | "speed" | "manual">("presets");
  const active = available?.available?.[selection.level]?.[selection.reasoning]?.[selection.speed] ?? false;
  const close = () => { setOpen(false); setPage("presets"); };
  const choose = (next: ModeSelection) => { onSelection(next); onPreset(); };
  const enabled = (level: Level) => available ? available.levels[level] : (level === "core" || level === "plus");
  const row = (name: string, description: string, click: () => void) => <button className="forma-mode-row" type="button" onClick={click}>
    <span>{name}</span><span className="forma-mode-row-value">{description}</span><ChevronRight size={17} />
  </button>;
  return <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) setPage("presets"); }}>
    <PopoverTrigger asChild>
      <button type="button" disabled={disabled} className="model-picker forma-mode-trigger" data-testid="button-mode-picker" aria-label="Режим Forma">
        {manual ? <Box size={16}/> : <Sparkles size={16}/>}
        <span>{manual ? "Ручной выбор" : `Forma · ${LEVEL_NAMES[selection.level]}`}</span><ChevronDown size={15}/>
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" side="top" sideOffset={10} className="forma-mode-popover" data-testid="menu-forma-modes">
      {page === "presets" && <>
        <div className="forma-mode-head"><Sparkles size={19}/><span>Forma · {LEVEL_NAMES[selection.level]}</span></div>
        <p className="forma-mode-caption">Уровень модели, рассуждения и скорость ответа — в одном месте.</p>
        <div className="forma-level-track" role="group" aria-label="Уровень модели">
          {LEVELS.map((level, index) => <button type="button" key={level} className={`forma-level-stop ${!manual && level === selection.level ? "selected" : ""}`} disabled={!enabled(level)} onClick={() => choose({ ...selection, level })} aria-label={`Уровень ${LEVEL_NAMES[level]}`} aria-pressed={!manual && level === selection.level} title={enabled(level) ? LEVEL_NAMES[level] : `${LEVEL_NAMES[level]} — скоро`}><span className="forma-level-dot"/><small>{LEVEL_NAMES[level]}</small></button>)}
        </div>
        <div className="forma-mode-summary"><span>Reasoning: {REASONING_NAMES[selection.reasoning]}</span><span>Speed: {SPEED_NAMES[selection.speed]}</span></div>
        <div className="forma-mode-availability">{!available ? "Проверяем настройки…" : active ? "Режим настроен" : "Для этого режима пока нет модели в YAML"}</div>
        <div className="forma-mode-line" />
        {row("Custom", "Настроить", () => setPage("custom"))}
        {row("Ручной выбор", "Ollama", () => setPage("manual"))}
      </>}
      {page === "custom" && <>
        <button className="forma-mode-back" onClick={() => setPage("presets")}><ChevronLeft size={16}/> Назад к режимам</button>
        <div className="forma-mode-line"/>
        {row("Уровень", LEVEL_NAMES[selection.level], () => setPage("levels"))}
        {row("Reasoning", REASONING_NAMES[selection.reasoning], () => setPage("reasoning"))}
        {row("Speed", SPEED_NAMES[selection.speed], () => setPage("speed"))}
        <p className="forma-mode-helper"><SlidersHorizontal size={14}/> Каждое сочетание использует модель из YAML.</p>
      </>}
      {page === "levels" && <>
        <button className="forma-mode-back" onClick={() => setPage("custom")}><ChevronLeft size={16}/> Уровень</button>
        {LEVELS.map(level => <button type="button" key={level} className="forma-mode-choice" disabled={!enabled(level)} onClick={() => { choose({ ...selection, level }); setPage("custom"); }}><span>{LEVEL_NAMES[level]}{!enabled(level) && <small>Скоро</small>}</span>{!manual && selection.level === level && <Check size={18}/>}</button>)}
      </>}
      {page === "reasoning" && <>
        <button className="forma-mode-back" onClick={() => setPage("custom")}><ChevronLeft size={16}/> Reasoning</button>
        {REASONING.map(reasoning => <button type="button" key={reasoning} className="forma-mode-choice" onClick={() => { choose({ ...selection, reasoning }); setPage("custom"); }}><span>{REASONING_NAMES[reasoning]}</span>{!manual && selection.reasoning === reasoning && <Check size={18}/>}</button>)}
      </>}
      {page === "speed" && <>
        <button className="forma-mode-back" onClick={() => setPage("custom")}><ChevronLeft size={16}/> Speed</button>
        {SPEEDS.map(speed => <button type="button" key={speed} className="forma-mode-choice" onClick={() => { choose({ ...selection, speed }); setPage("custom"); }}><span><Gauge size={16}/> {SPEED_NAMES[speed]}</span>{!manual && selection.speed === speed && <Check size={18}/>}</button>)}
      </>}
      {page === "manual" && <>
        <button className="forma-mode-back" onClick={() => setPage("presets")}><ChevronLeft size={16}/> Ручной выбор</button>
        <div className="forma-mode-model-list">{models.length ? models.map(m => <button type="button" key={m.name} className="forma-mode-choice" onClick={() => { onManual(m.name); close(); }}><span className="forma-mode-real-model">{m.name}</span>{manual && manualModel === m.name && <Check size={18}/>}</button>) : <p className="forma-mode-caption">Нет доступных моделей Ollama.</p>}</div>
        <button className="forma-mode-manage" onClick={() => { close(); onManage(); }}>Управление моделями <ChevronRight size={16}/></button>
      </>}
    </PopoverContent>
  </Popover>;
}
