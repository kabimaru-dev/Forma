import { useEffect, useRef, useState } from "react";
import type { Level } from "./ModePicker";
import "./MoleculeLevelButton.css";

// The button is informational only. It never changes the mode selection.
// Keep both visual versions available for possible future use.
export const MOLECULE_LEVEL_NUMBERS: Record<Level, 1 | 3 | 5 | 9> = {
  minimal: 1,
  moderate: 3,
  intensive: 5,
  extreme: 9,
};

type Point = { x: number; y: number };
const CENTER: Point = { x: 18, y: 18 };
const CORAL = "#e18a69";
const BRIGHT = "#f3aa83";
const QUIET = "#665650";
const WIRE = "#c97b60";
const WIRE_MUTED = "#765146";

// Exact v3 molecule proportions, fitted inside the 36×36 button.
const ORBIT: Point[] = [
  [12, 2.8], [17.7, 4.9], [20.9, 10], [20, 16.4], [15.7, 20.4],
  [8.3, 20.4], [4, 16.4], [3.1, 10], [6.3, 4.9],
].map(([x, y]) => ({ x: (x - 12) * 1.18 + 18, y: (y - 12) * 1.18 + 18 }));

const CHAOS: Point[] = [
  [18, 3.2], [26.6, 7], [32.1, 12.5], [30.1, 23.5], [23.8, 30.9],
  [13.4, 30.6], [4.3, 24.9], [3.7, 13.7], [9.7, 5.5], [16.4, 10.5],
  [24.7, 12.8], [24.6, 20.3], [16.2, 25.3], [9.8, 20.7], [10.2, 12.6],
  [22.4, 1.8], [34.1, 7.4], [34, 20.5], [29, 32.5], [9, 33.8],
  [1.9, 29], [1.2, 8.1], [6.8, 1.4], [19.2, 33.1],
].map(([x, y]) => ({ x, y }));

const CHAOS_CONNECTIONS: [number, number][] = [
  [0, 9], [9, 1], [1, 10], [10, 2], [2, 16], [16, 17], [17, 3],
  [3, 11], [11, 4], [4, 18], [18, 5], [5, 12], [12, 6], [6, 20],
  [20, 7], [7, 21], [21, 8], [8, 22], [22, 0], [0, 15], [15, 1],
  [1, 2], [2, 3], [3, 4], [4, 23], [23, 5], [5, 6], [6, 7], [7, 8],
  [8, 0], [9, 10], [10, 11], [11, 12], [12, 13], [13, 14], [14, 9],
  [0, 12], [8, 11], [2, 13], [6, 10], [4, 14], [7, 11], [1, 12],
  [3, 14], [16, 10], [19, 6], [20, 13], [18, 11], [22, 9],
];

function Stroke({ from, to, width = 1.6, color = WIRE }: {
  from: Point; to: Point; width?: number; color?: string;
}) {
  return <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={color} strokeWidth={width} strokeLinecap="round" />;
}

function Dot({ point, size = 2, color = CORAL }: {
  point: Point; size?: number; color?: string;
}) {
  return <circle cx={point.x} cy={point.y} r={size} fill={color} />;
}

export function MoleculeGlyph({ level }: { level: Level }) {
  const value = MOLECULE_LEVEL_NUMBERS[level];
  return <svg viewBox="0 0 36 36" width="32" height="32" aria-hidden="true" focusable="false">
    {value === 1 && <Dot point={CENTER} size={2.5} color={BRIGHT} />}

    {value === 3 && <>
      {[0, 3, 6].map(i => <Stroke key={`line-${i}`} from={CENTER} to={ORBIT[i]} width={1.65} />)}
      <Dot point={CENTER} size={2.05} color={BRIGHT} />
      {[0, 3, 6].map(i => <Dot key={`dot-${i}`} point={ORBIT[i]} size={2.15} />)}
    </>}

    {value === 5 && <>
      {/* Exactly five connections: unchanged from the approved v3 version. */}
      {([[CENTER, ORBIT[0]], [CENTER, ORBIT[2]], [CENTER, ORBIT[3]],
        [CENTER, ORBIT[6]], [ORBIT[0], ORBIT[8]]] as [Point, Point][])
        .map(([a, b], i) => <Stroke key={i} from={a} to={b} width={1.7} />)}
      <Dot point={CENTER} size={2.25} color={BRIGHT} />
      {[0, 2, 3, 6, 8].map(i => <Dot key={i} point={ORBIT[i]} size={2.15} />)}
      {[1, 4, 5, 7].map(i => <Dot key={i} point={ORBIT[i]} size={1.5} color={QUIET} />)}
    </>}

    {value === 9 && <>
      {CHAOS_CONNECTIONS.map(([a, b], i) => <Stroke key={`chaos-${i}`} from={CHAOS[a]} to={CHAOS[b]}
        width={i % 4 === 0 ? 1.12 : .85} color={i % 3 === 0 ? WIRE : WIRE_MUTED} />)}
      {[0, 2, 4, 6, 8, 9, 10, 11, 12, 13, 14].map((i, j) =>
        <Stroke key={`radial-${i}`} from={CENTER} to={CHAOS[i]} width={j % 2 ? 1.1 : .85}
          color={j % 3 === 0 ? WIRE : WIRE_MUTED} />)}
      <path d="M22.4 1.8 L24.8 5.4 L26.6 7 M34.1 7.4 L30.7 9.4 L32.1 12.5 M1.9 29 L5.7 26.2 L4.3 24.9"
        fill="none" stroke={BRIGHT} strokeWidth={1} />
      {CHAOS.map((point, i) => <Dot key={`chaos-dot-${i}`} point={point}
        size={i >= 9 ? 1.5 : 1.7} color={i % 4 === 0 ? BRIGHT : i % 3 === 0 ? QUIET : CORAL} />)}
      <Dot point={CENTER} size={2.45} color={BRIGHT} />
    </>}
  </svg>;
}

type ButtonProps = { level: Level };

function MoleculeLevelButton({ level, lit }: ButtonProps & { lit: boolean }) {
  const [visible, setVisible] = useState(false);
  const [pressCount, setPressCount] = useState(0);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const number = MOLECULE_LEVEL_NUMBERS[level];

  useEffect(() => () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
  }, []);

  function showInformation() {
    setPressCount(c => c + 1);
    setVisible(true);
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = setTimeout(() => setVisible(false), 5000);
  }

  return <span className="forma-molecule-holder">
    <button type="button"
      className={`forma-molecule-button ${lit ? "forma-molecule--lit" : "forma-molecule--unlit"}`}
      aria-label={`Информация об уровне ${number}`}
      title={`Уровень ${number}`}
      data-testid="button-molecule-level"
      onClick={showInformation}>
      <span key={pressCount} className={pressCount ? "forma-molecule-pressed" : ""}>
        <MoleculeGlyph level={level} />
      </span>
    </button>
    {visible && <span key={pressCount} className="forma-molecule-tooltip" role="status"
      data-testid="molecule-level-tooltip">Уровень {number}</span>}
  </span>;
}

/** The only version currently rendered in the interface: neutral and unlit. */
export function MoleculeLevelButtonUnlit(props: ButtonProps) {
  return <MoleculeLevelButton {...props} lit={false} />;
}

/** Preserved for future designs. Not rendered by Forma at present. */
export function MoleculeLevelButtonLit(props: ButtonProps) {
  return <MoleculeLevelButton {...props} lit={true} />;
}
