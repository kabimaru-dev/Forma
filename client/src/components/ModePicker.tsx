import { useRef, useState, type CSSProperties, type PointerEvent, type KeyboardEvent } from "react";
import { Check, ChevronRight, SlidersHorizontal } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { MoleculeLevelButtonUnlit } from "./MoleculeLevelButton";

// Keys are stable identifiers for localStorage, API requests and config/modes.yaml.
export const LEVELS = ["minimal", "moderate", "intensive", "extreme"] as const;
export const REASONING = ["minimal", "low", "medium", "high", "extra_high", "max", "ultra"] as const;
export const SPEEDS = ["normal", "fast"] as const;
export const CUSTOM_KEYS = ["option_1", "option_2", "option_3", "option_4", "option_5"] as const;
export type Level = typeof LEVELS[number];
export type Reasoning = typeof REASONING[number];
export type Speed = typeof SPEEDS[number];
export type CustomKey = typeof CUSTOM_KEYS[number];
export type ModeSelection = { level: Level; reasoning: Reasoning; speed: Speed; model?: string };
export type ModesPublic = {
  modelChoices?: Record<string, { label: string; enabled: boolean }>;
  levels: Record<Level, boolean>;
  reasoning: Record<Level, Record<Reasoning, boolean>>;
  speed: Record<Speed, boolean>;
  custom: { enabled: boolean; options: Record<CustomKey, { enabled: boolean; label: string }> };
  available: Record<Level, Record<Reasoning, Record<Speed, boolean>>>;
};

export const LEVEL_NAMES: Record<Level, string> = { minimal: "Light", moderate: "Standard", intensive: "Terra", extreme: "Harmony" };
export const REASONING_NAMES: Record<Reasoning, string> = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", extra_high: "Extra", max: "Max", ultra: "Ultra" };
export const SPEED_NAMES: Record<Speed, string> = { normal: "Normal", fast: "Fast" };
export function modeId(selection: ModeSelection) { return `forma:${selection.level}:${selection.reasoning}:${selection.speed}${selection.model && selection.model !== "default" ? ":" + selection.model : ""}`; }
export function readableMode(id?: string): string {
  const match = /^forma:(minimal|moderate|intensive|extreme|core|plus|pro|ultra):(minimal|low|medium|high|extra_high|max|ultra):(normal|fast)(?::(model_0[2-7]))?$/.exec(id || "");
  if (!match) return id || "Forma";
  const legacy: Record<string, Level> = { core: "minimal", plus: "moderate", pro: "intensive", ultra: "extreme" };
  const tier = (legacy[match[1]] || match[1]) as Level;
  return `${LEVEL_NAMES[tier]} · ${REASONING_NAMES[match[2] as Reasoning]}`;
}

type Props = {
  selection: ModeSelection;
  available?: ModesPublic;
  disabled: boolean;
  onSelection: (next: ModeSelection) => void;
  onOpenSettings: () => void;
};
type Section = "reasoning" | "speed" | "model" | null;

export default function ModePicker({ selection, available, disabled, onSelection, onOpenSettings }: Props) {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [section, setSection] = useState<Section>(null);
  const [dragPercent, setDragPercent] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const position = LEVELS.indexOf(selection.level);
  const canLevel = (level: Level) => available ? !!available.levels[level] : level === "minimal" || level === "moderate";
  const canReasoning = (value: Reasoning) => available ? !!available.reasoning?.[selection.level]?.[value] : false;
  const canSpeed = (value: Speed) => available ? !!available.speed[value] : false;
  const modelChoices = available?.modelChoices || { default: { label: "Anime-Sakura", enabled: true }, ...Object.fromEntries(Array.from({length:6}, (_, i) => [`model_0${i+2}`, {label:`Model 0${i+2}`,enabled:false}])) };
  const modelKey = selection.model || "default";
  const chooseLevel = (level: Level) => {
    if (!disabled && canLevel(level)) onSelection({ ...selection, level });
  };
  const percentAt = (clientX: number) => {
    const bounds = track.current?.getBoundingClientRect();
    return bounds ? Math.max(0, Math.min(1, (clientX - bounds.left - bounds.width * .08) / (bounds.width * .84))) : position / 3;
  };
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSettingsOpen(false); setSection(null); setDragPercent(percentAt(event.clientX));
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragPercent === null) return;
    chooseLevel(LEVELS[Math.round(percentAt(event.clientX) * 3)]);
    setDragPercent(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onSliderKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = ["ArrowRight","ArrowUp"].includes(event.key) ? 1 : ["ArrowLeft","ArrowDown"].includes(event.key) ? -1 : 0;
    if (!delta && !["Home", "End"].includes(event.key)) return;
    event.preventDefault();
    chooseLevel(LEVELS[Math.max(0, Math.min(3, event.key === "Home" ? 0 : event.key === "End" ? 3 : position + delta))]);
  };
  const changeOpen = (next: boolean) => { setOpen(next); if (!next) { setSettingsOpen(false); setSection(null); setDragPercent(null); } };
  const menuRow = (key: Exclude<Section,null>, value: string) => {
    const items = key === "reasoning" ? REASONING.map(id => ({id,label:REASONING_NAMES[id],enabled:canReasoning(id)}))
      : key === "speed" ? SPEEDS.map(id => ({id,label:SPEED_NAMES[id],enabled:canSpeed(id)}))
      : Object.entries(modelChoices).map(([id, item]) => ({id,...item}));
    const selected = key === "model" ? modelKey : selection[key];
    return <Popover open={section === key} onOpenChange={next => setSection(next ? key : null)}>
      <PopoverTrigger asChild><button className="forma-mode-row" type="button" disabled={disabled}>
        <span>{key[0].toUpperCase()+key.slice(1)}</span><span className="forma-mode-row-value">{value}</span><ChevronRight size={12.75}/>
      </button></PopoverTrigger>
      <PopoverContent align="start" side="right" sideOffset={7.5} collisionPadding={6} className="forma-mode-submenu" data-testid={`menu-forma-${key}`}>
        {items.map(item => <button key={item.id} className="forma-mode-choice" type="button" disabled={disabled || !item.enabled} aria-pressed={selected === item.id}
          onClick={() => { onSelection({...selection,[key]:item.id}); setSection(null); }}>
          <span>{item.label}</span>{selected === item.id && <Check size={10.5}/>}</button>)}
      </PopoverContent>
    </Popover>;
  };
  return <Popover open={open} onOpenChange={changeOpen}>
    <div className="forma-mode-trigger-group">
      <PopoverTrigger asChild><button type="button" disabled={disabled} className="forma-mode-trigger" data-testid="button-mode-picker" aria-label="Выбрать уровень Forma">
        {LEVEL_NAMES[selection.level]} - {REASONING_NAMES[selection.reasoning]}
      </button></PopoverTrigger>
      <MoleculeLevelButtonUnlit level={selection.level} />
      <button type="button" className="forma-mode-trigger forma-settings-trigger" aria-label="Параметры ответа" title="Параметры ответа" data-testid="button-generation-settings" onClick={() => { changeOpen(false); onOpenSettings(); }}><SlidersHorizontal size={18}/></button>
    </div>
    <PopoverContent id="forma-mode-popup" align="end" side="bottom" sideOffset={7.5} collisionPadding={6} className="forma-mode-popover" data-testid="menu-forma-modes">
      <div className="forma-mode-head">{LEVEL_NAMES[selection.level]}</div>
      <div ref={track} className="forma-level-track" role="slider" aria-label="Уровень мощности" aria-valuemin={0} aria-valuemax={3} aria-valuenow={position} aria-valuetext={LEVEL_NAMES[selection.level]} tabIndex={disabled ? -1 : 0}
        data-dragging={dragPercent !== null} style={{"--forma-progress":dragPercent ?? position / 3} as CSSProperties}
        onPointerDown={startDrag} onPointerMove={e => {if (dragPercent !== null) setDragPercent(percentAt(e.clientX));}} onPointerUp={endDrag} onPointerCancel={() => setDragPercent(null)} onLostPointerCapture={() => setDragPercent(null)} onKeyDown={onSliderKey}>
        <div className="forma-level-rail"><div className="forma-level-fill" aria-hidden="true"><span className="forma-level-arrows">{[0,1,2,3].map(i => <svg key={i} viewBox="0 0 12 18"><path d="m3 3 6 6-6 6"/></svg>)}</span></div></div>
        {LEVELS.map((level,index) => <span key={level} className="forma-level-mark" data-locked={!canLevel(level)} style={{"--mark":index / 3} as CSSProperties} aria-hidden="true" title={LEVEL_NAMES[level]}/>)}
        <div className="forma-level-thumb" aria-hidden="true"/>
      </div>
      <Popover open={settingsOpen} onOpenChange={next => {setSettingsOpen(next); if (!next) setSection(null);}}>
        <PopoverTrigger asChild><button className="forma-mode-row forma-mode-summary" type="button"><span>{LEVEL_NAMES[selection.level]}</span><span className="forma-mode-row-value">{selection.speed !== "normal" || modelKey !== "default" ? "Custom" : REASONING_NAMES[selection.reasoning]}</span><ChevronRight size={12.75}/></button></PopoverTrigger>
        <PopoverContent align="start" side="right" sideOffset={7.5} collisionPadding={6} className="forma-mode-submenu forma-mode-settings">
          {menuRow("reasoning", REASONING_NAMES[selection.reasoning])}
          {menuRow("speed", SPEED_NAMES[selection.speed])}
          {menuRow("model", modelChoices[modelKey]?.label || "Anime-Sakura")}
        </PopoverContent>
      </Popover>
    </PopoverContent>
  </Popover>;
}
