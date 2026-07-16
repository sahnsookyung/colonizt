import { useMemo, type CSSProperties, type KeyboardEvent } from "react";
import type { GameEvent, GameState, PlayerId, ViewerState } from "@colonizt/game-core";
import {
  BotSymbol,
  DevelopmentCardIcon,
  HouseSymbol,
  HumanSymbol,
  KnightStatSymbol,
  ResourceCard,
  RoadStatSymbol,
  VictoryPointStatSymbol,
} from "./game-ui.js";
import { summarizeDevelopmentDraws, summarizeResourceDraws } from "../game-analysis.js";
import { AccessibleDialog } from "./accessible-dialog.js";

export type GameOverTab = "overview" | "dice" | "resources" | "development";

const developmentCardShortLabels = {
  KNIGHT: "Knight",
  ROAD_BUILDING: "Roads",
  MONOPOLY: "Monopoly",
  YEAR_OF_PLENTY: "Plenty",
  VICTORY_POINT: "+1 VP",
} as const;

const tabs: Array<{ id: GameOverTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "dice", label: "Dice Stats" },
  { id: "resources", label: "Resource Cards" },
  { id: "development", label: "Development Cards" },
];

const confettiColors = ["#22c55e", "#f97316", "#f43f5e", "#3b82f6", "#facc15", "#14b8a6", "#8b5cf6"];
const confettiPieces = Array.from({ length: 42 }, (_, index) => ({
  left: `${(index * 23 + 7) % 100}%`,
  delay: `${-(index % 11) * 0.22}s`,
  duration: `${2.4 + (index % 6) * 0.22}s`,
  rotate: `${(index * 31) % 360}deg`,
  color: confettiColors[index % confettiColors.length]!,
}));

export const victoryPointText = (player: ViewerState["players"][number], compact = false): string => {
  const secret = player.secretVictoryPoints ?? 0;
  const total = player.visibleVictoryPoints ?? player.score;
  const publicPoints = player.publicVictoryPoints ?? Math.max(0, total - secret);
  if (secret <= 0 || total === publicPoints) return compact ? `${total}VP` : `${total} VP`;
  return compact ? `${publicPoints}(${total})VP` : `${publicPoints} (${total}) VP`;
};

export const victoryPointAria = (player: ViewerState["players"][number]): string => {
  const secret = player.secretVictoryPoints ?? 0;
  const total = player.visibleVictoryPoints ?? player.score;
  if (secret <= 0) return `${total} victory points`;
  return `${total} victory points, including ${secret} secret victory point${secret === 1 ? "" : "s"}`;
};

interface MatchAnalysisProps {
  state: GameState;
  players: ViewerState["players"];
  events: GameEvent[];
  botPlayerIds: Set<PlayerId>;
  tab: GameOverTab;
  onTabChange(tab: GameOverTab): void;
  onReplay(): void;
  onNewMatch(): void;
}

export const MatchAnalysis = ({ state, players, events, botPlayerIds, tab, onTabChange, onReplay, onNewMatch }: MatchAnalysisProps) => {
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentTab: GameOverTab): void => {
    const currentIndex = tabs.findIndex((item) => item.id === currentTab);
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex]!;
    onTabChange(nextTab.id);
    event.currentTarget.parentElement?.querySelector<HTMLElement>(`#analysis-tab-${nextTab.id}`)?.focus();
  };
  const rankedPlayers = useMemo(
    () => [...players].sort((left, right) =>
      (right.visibleVictoryPoints ?? right.score) - (left.visibleVictoryPoints ?? left.score)
      || state.playerOrder.indexOf(left.id) - state.playerOrder.indexOf(right.id)),
    [players, state.playerOrder],
  );
  const maxima = useMemo(() => {
    const result = { settlements: 0, cities: 0, longestRoad: 0, largestArmy: 0, secret: 0, otherPublic: 0 };
    for (const player of rankedPlayers) {
      const breakdown = player.victoryPointBreakdown;
      for (const key of Object.keys(result) as Array<keyof typeof result>) result[key] = Math.max(result[key], breakdown?.[key] ?? 0);
    }
    return result;
  }, [rankedPlayers]);
  const diceStats = useMemo(() => {
    const counts = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [index + 2, 0])) as Record<number, number>;
    for (const event of events) if (event.type === "DICE_ROLLED") counts[event.sum] = (counts[event.sum] ?? 0) + 1;
    return Object.entries(counts).map(([sum, count]) => ({ sum: Number(sum), count }));
  }, [events]);
  const resourceStats = useMemo(() => summarizeResourceDraws(events), [events]);
  const developmentStats = useMemo(() => summarizeDevelopmentDraws(events), [events]);
  const maxDice = Math.max(1, ...diceStats.map((stat) => stat.count));
  const maxResources = Math.max(1, ...resourceStats.map((stat) => stat.count));
  const maxDevelopment = Math.max(1, ...developmentStats.map((stat) => stat.count));

  if (state.phase.type !== "GAME_OVER") return null;
  return (
    <AccessibleDialog className="game-over-overlay" label="Victory analysis">
      <div className="confetti-layer" aria-hidden="true">
        {confettiPieces.map((piece) => (
          <span key={`${piece.left}:${piece.delay}:${piece.duration}:${piece.rotate}`} style={{
            "--confetti-left": piece.left,
            "--confetti-delay": piece.delay,
            "--confetti-duration": piece.duration,
            "--confetti-rotate": piece.rotate,
            "--confetti-color": piece.color,
          } as CSSProperties} />
        ))}
      </div>
      <div className="game-over-title">
        <strong>{state.players[state.phase.winnerId]?.name ?? state.phase.winnerId} wins</strong>
        <span>Turn {state.turn + 1}</span>
      </div>
      <div className="analysis-tabs" role="tablist" aria-label="Game analysis sections">
        {tabs.map((item) => (
          <button
            key={item.id}
            id={`analysis-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`analysis-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            className={tab === item.id ? "selected" : ""}
            onClick={() => onTabChange(item.id)}
            onKeyDown={(event) => onTabKeyDown(event, item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        id={`analysis-panel-${tab}`}
        className="analysis-panel"
        role="tabpanel"
        aria-labelledby={`analysis-tab-${tab}`}
        tabIndex={0}
      >
        {tab === "overview" ? (
          <div className="victory-breakdown-list">
            {rankedPlayers.map((player, index) => {
              const breakdown = player.victoryPointBreakdown;
              const parts = [
                { key: "settlements", label: "Settlements", value: breakdown?.settlements ?? 0, icon: <HouseSymbol /> },
                { key: "cities", label: "Cities", value: breakdown?.cities ?? 0, icon: <HouseSymbol city /> },
                { key: "longestRoad", label: "Longest Road", value: breakdown?.longestRoad ?? 0, icon: <RoadStatSymbol /> },
                { key: "largestArmy", label: "Largest Army", value: breakdown?.largestArmy ?? 0, icon: <KnightStatSymbol /> },
                { key: "secret", label: "Secret VP", value: breakdown?.secret ?? 0, icon: <DevelopmentCardIcon type="VICTORY_POINT" /> },
                { key: "otherPublic", label: "Other", value: breakdown?.otherPublic ?? 0, icon: <VictoryPointStatSymbol /> },
              ].filter((part) => part.value > 0);
              return (
                <article key={player.id} className="victory-breakdown-row" style={{ borderColor: player.color }}>
                  <div className="victory-rank">{index + 1}</div>
                  <div className="victory-player">
                    <span className="player-kind" style={{ color: player.color }}>{botPlayerIds.has(player.id) ? <BotSymbol /> : <HumanSymbol />}</span>
                    <strong>{player.name}</strong>
                    <span className={player.secretVictoryPoints ? "vp-secret" : ""}>{victoryPointText(player)}</span>
                  </div>
                  <div className="victory-parts">
                    {parts.map((part) => (
                      <span key={part.key} className={`victory-part ${part.value === maxima[part.key as keyof typeof maxima] ? "best" : ""}`} title={part.label}>
                        {part.icon}<span>{part.value}</span>
                      </span>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
        {tab === "dice" ? (
          <div className="analysis-chart dice-chart" aria-label="Dice roll counts"><h2>Dice Rolls</h2><div className="chart-bars">
            {diceStats.map((stat) => <div key={stat.sum} className={`chart-bar-item ${stat.count === maxDice && stat.count > 0 ? "best" : ""}`}><span className="chart-bar" style={{ "--bar-height": `${Math.max(6, (stat.count / maxDice) * 100)}%` } as CSSProperties}><strong>{stat.count}</strong></span><small>{stat.sum}</small></div>)}
          </div></div>
        ) : null}
        {tab === "resources" ? (
          <div className="analysis-chart resource-chart" aria-label="Resource cards drawn"><h2>Resource Cards Drawn</h2><div className="chart-bars resource-bars">
            {resourceStats.map((stat) => <div key={stat.resource} className={`chart-bar-item ${stat.count === maxResources && stat.count > 0 ? "best" : ""}`}><span className="chart-bar" style={{ "--bar-height": `${Math.max(6, (stat.count / maxResources) * 100)}%` } as CSSProperties}><strong>{stat.count}</strong></span><ResourceCard resource={stat.resource} count={stat.count} compact /></div>)}
          </div></div>
        ) : null}
        {tab === "development" ? (
          <div className="analysis-chart development-chart" aria-label="Development cards drawn"><h2>Development Cards Drawn</h2><div className="chart-bars development-bars">
            {developmentStats.map((stat) => <div key={stat.type} className={`chart-bar-item ${stat.count === maxDevelopment && stat.count > 0 ? "best" : ""}`}><span className="chart-bar" style={{ "--bar-height": `${Math.max(6, (stat.count / maxDevelopment) * 100)}%` } as CSSProperties}><strong>{stat.count}</strong></span><DevelopmentCardIcon type={stat.type} /><small>{developmentCardShortLabels[stat.type]}</small></div>)}
          </div></div>
        ) : null}
      </div>
      <div className="game-over-actions">
        <button type="button" aria-label="Open replay" onClick={onReplay}>Replay</button>
        <button type="button" onClick={onNewMatch}>New Match</button>
      </div>
    </AccessibleDialog>
  );
};
