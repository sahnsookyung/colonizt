import { resources, type PlayerId, type SerializedPlayer } from "@colonizt/game-core";
import {
  BotSymbol,
  CardsSymbol,
  DevelopmentCardIcon,
  HumanSymbol,
  KnightStatSymbol,
  ResourceCard,
  RoadStatSymbol,
  VictoryPointStatSymbol,
} from "./game-ui.js";

export interface PlayerStatsListProps {
  players: SerializedPlayer[];
  botPlayerIds: ReadonlySet<PlayerId>;
  victoryPointText: (player: SerializedPlayer, compact?: boolean) => string;
  victoryPointAria: (player: SerializedPlayer) => string;
  activePlayerId?: PlayerId;
}

export const PlayerStatsList = ({
  players,
  botPlayerIds,
  victoryPointText,
  victoryPointAria,
  activePlayerId,
}: PlayerStatsListProps) => (
  <div className="players">
    {players.map((player) => {
      const isBot = botPlayerIds.has(player.id);
      return (
        <article key={player.id} className={`player ${player.id === activePlayerId ? "active" : ""} ${isBot ? "bot-player" : "human-player"}`} style={{ borderColor: player.color }}>
          <div className="player-heading">
            <span className="player-kind" style={{ color: player.color }} role="img" aria-label={isBot ? `${player.name} is a bot` : `${player.name} is a player`}>
              {isBot ? <BotSymbol /> : <HumanSymbol />}
            </span>
            <strong>{player.name}</strong>
            <div className="player-stats" aria-label={`${victoryPointAria(player)}, ${player.resourceCount} resource cards, ${player.developmentCardCount} development cards, ${player.playedKnights} knights, longest road length ${player.longestRoadLength}`}>
              <span className={`stat-chip vp-chip ${player.secretVictoryPoints ? "vp-secret" : ""}`} title="Victory points">
                <VictoryPointStatSymbol />
                <span>{victoryPointText(player)}</span>
              </span>
              <span className="stat-chip" title="Resource cards">
                <CardsSymbol />
                <span>{player.resourceCount}</span>
              </span>
              <span className="stat-chip" title="Development cards">
                <DevelopmentCardIcon hidden />
                <span>{player.developmentCardCount}</span>
              </span>
              <span className="stat-chip" title="Knights used">
                <KnightStatSymbol />
                <span>{player.playedKnights}</span>
              </span>
              <span className="stat-chip" title="Road length">
                <RoadStatSymbol />
                <span>{player.longestRoadLength}</span>
              </span>
            </div>
            <div className="player-mobile-stats" aria-hidden="true">
              <span className={player.secretVictoryPoints ? "vp-secret" : ""}>{victoryPointText(player, true)}</span>
              <span>{player.resourceCount}C</span>
              <span>{player.developmentCardCount}D</span>
              <span>R{player.longestRoadLength}</span>
            </div>
          </div>
          <div className="player-awards">
            {player.hasLongestRoad ? <span className="badge">Longest Road</span> : null}
            {player.hasLargestArmy ? <span className="badge">Largest Army</span> : null}
          </div>
          {player.resources ? (
            <div className="mini-resources">
              {resources.map((resource) => <ResourceCard key={resource} resource={resource} count={player.resources?.[resource] ?? 0} compact />)}
            </div>
          ) : null}
        </article>
      );
    })}
  </div>
);
