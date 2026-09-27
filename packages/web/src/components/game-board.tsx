import { useEffect, useId, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import type {
  EdgeId,
  GameState,
  HexId,
  PlayerId,
  VertexId,
} from "@colonizt/game-core";
import { boardBounds } from "../board-interactions.js";
import { useBoardCamera } from "../hooks/useBoardCamera.js";
import { BoardHousePiece, BoardIcon, terrainLabels } from "./game-ui.js";

const atlasUrl = new URL("../assets/terrain-atlas.png", import.meta.url).href;
const terrainCell = {
  timber: [0, 0],
  brick: [1, 0],
  grain: [2, 0],
  fiber: [0, 1],
  ore: [1, 1],
  desert: [2, 1],
} as const;
const crests = ["◆", "●", "▲", "✦", "■", "✚", "◇", "○"];
type BoardSelectionKind = "edge" | "vertex" | "hex";
export const playerCrest = (
  state: Pick<GameState, "playerOrder">,
  id: PlayerId,
) => crests[state.playerOrder.indexOf(id)] ?? "◆";
interface Props {
  state: GameState;
  humanPlayerId: PlayerId;
  legalRoads: ReadonlySet<EdgeId>;
  legalSettlements: ReadonlySet<VertexId>;
  legalCities: ReadonlySet<VertexId>;
  legalThiefHexes: ReadonlySet<HexId>;
  pendingSetupVertex: VertexId | null;
  roadBuildingSelectedEdges: EdgeId[];
  disabled: boolean;
  onVertex(id: VertexId): void;
  onEdge(id: EdgeId): void;
  onHex(id: HexId): void;
  onCancel(): void;
  visibleStealTargets(id: HexId): PlayerId[];
}

export const GameBoard = ({
  state,
  humanPlayerId,
  legalRoads,
  legalSettlements,
  legalCities,
  legalThiefHexes,
  pendingSetupVertex,
  roadBuildingSelectedEdges,
  disabled,
  onVertex,
  onEdge,
  onHex,
  onCancel,
  visibleStealTargets,
}: Props) => {
  const uid = useId().replaceAll(":", "");
  const bounds = useMemo(() => boardBounds(state), [state.board]);
  const camera = useBoardCamera(
    bounds.width,
    bounds.height,
    state.config.matchId,
  );
  const [selection, setSelection] = useState<{
    kind: BoardSelectionKind;
    id: string;
  } | null>(null);
  useEffect(() => setSelection(null), [state.eventSeq, state.config.matchId]);
  const centerX = bounds.minX + bounds.width / 2,
    centerY = bounds.minY + bounds.height / 2;
  const hitRadius = Math.max(
    0.22,
    (22 * camera.unitPerPixel) / camera.camera.scale,
  );
  const tokenRadius = Math.max(0.25, 11 * camera.unitPerPixel / camera.camera.scale);
  const tokenFontSize = Math.max(0.23, 12 * camera.unitPerPixel / camera.camera.scale);
  const validSelection =
    selection &&
    (selection.kind === "edge"
      ? legalRoads.has(selection.id) ||
        roadBuildingSelectedEdges.includes(selection.id)
      : selection.kind === "vertex"
        ? legalSettlements.has(selection.id) || legalCities.has(selection.id)
        : legalThiefHexes.has(selection.id))
      ? selection
      : null;
  const select = (kind: BoardSelectionKind, id: string) => {
    if (!disabled) setSelection({ kind, id });
  };
  const selectFromPointer = (event: MouseEvent<SVGGElement>, kind: BoardSelectionKind, fallback: string) => {
    event.stopPropagation();
    const transform = event.currentTarget.getScreenCTM?.();
    if (!event.detail || !transform) { select(kind, fallback); return; }
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
    const candidates = kind === "vertex"
      ? Object.values(state.board.vertices).filter((vertex) => legalSettlements.has(vertex.id) || legalCities.has(vertex.id))
      : kind === "edge"
        ? Object.values(state.board.edges).filter((edge) => legalRoads.has(edge.id) || roadBuildingSelectedEdges.includes(edge.id)).map((edge) => {
          const a = state.board.vertices[edge.vertices[0]]!, b = state.board.vertices[edge.vertices[1]]!;
          return { id: edge.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        })
        : hexes.filter((hex) => legalThiefHexes.has(hex.id));
    // Dense phone targets overlap. Distance, never SVG paint order, decides the preview.
    const nearest = candidates.reduce<{ id: string; distance: number }>((best, candidate) => {
      const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
      return distance < best.distance ? { id: candidate.id, distance } : best;
    }, { id: fallback, distance: Infinity });
    select(kind, nearest.id);
  };
  const confirm = () => {
    if (!validSelection || disabled) return;
    if (validSelection.kind === "edge") onEdge(validSelection.id);
    else if (validSelection.kind === "vertex") onVertex(validSelection.id);
    else onHex(validSelection.id);
    setSelection(null);
  };
  const activate = (
    event: KeyboardEvent<SVGGElement>,
    kind: BoardSelectionKind,
    id: string,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(kind, id);
    }
  };
  const cancel = () => {
    setSelection(null);
    onCancel();
  };
  const hexes = useMemo(
    () =>
      Object.values(state.board.hexes).map((hex) => {
        const vertices = state.board.adjacency.hexToVertices[hex.id]!.map(
          (id) => state.board.vertices[id]!,
        );
        return {
          ...hex,
          points: vertices.map((v) => `${v.x},${v.y}`).join(" "),
          x: vertices.reduce((sum, v) => sum + v.x / 6, 0),
          y: vertices.reduce((sum, v) => sum + v.y / 6, 0),
        };
      }),
    [state.board],
  );
  return (
    <div
      className="board-viewport"
      role="group"
      aria-label="Game board controls"
      onKeyDown={(event) => {
        if (event.key === "Escape") cancel();
      }}
    >
      <svg
        ref={camera.svgRef}
        className="board"
        viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}
        role="group"
        aria-label="Resource board"
        onPointerDown={camera.onPointerDown}
        onPointerMove={camera.onPointerMove}
        onPointerUp={camera.onPointerUp}
        onPointerCancel={camera.onPointerUp}
        onClickCapture={camera.onClickCapture}
        onClick={cancel}
      >
        <defs>
          {hexes.map((hex) => (
            <clipPath key={hex.id} id={`${uid}-${hex.id}`}>
              <polygon points={hex.points} />
            </clipPath>
          ))}
        </defs>
        <g
          transform={`translate(${centerX + camera.camera.x} ${centerY + camera.camera.y}) scale(${camera.camera.scale}) translate(${-centerX} ${-centerY})`}
        >
          <g className="coast-layer" aria-hidden="true">
            {hexes.map((hex) => (
              <polygon key={hex.id} points={hex.points} />
            ))}
          </g>
          <g className="terrain-layer">
            {hexes.map((hex, index) => {
              const [col, row] = terrainCell[hex.resource];
              return (
                <g key={hex.id}>
                  <polygon
                    className={`hex hex-${hex.resource}`}
                    points={hex.points}
                  >
                    <title>{terrainLabels[hex.resource]}</title>
                  </polygon>
                  <g clipPath={`url(#${uid}-${hex.id})`} aria-hidden="true">
                    <g
                      transform={
                        index % 2
                          ? `translate(${hex.x * 2} 0) scale(-1 1)`
                          : undefined
                      }
                    >
                      <svg
                        x={hex.x - 1}
                        y={hex.y - 1}
                        width="2"
                        height="2"
                        viewBox={`${col * 512} ${row * 512} 512 512`}
                        preserveAspectRatio="xMidYMid slice"
                      >
                        <image href={atlasUrl} width="1536" height="1024" />
                      </svg>
                    </g>
                  </g>
                  <polygon className="hex-outline" points={hex.points} />
                </g>
              );
            })}
          </g>
          <g className="harbor-layer">
            {Object.values(state.board.ports).map((port) => {
              const a = state.board.vertices[port.vertexIds[0]]!,
                b = state.board.vertices[port.vertexIds[1]]!;
              const mx = (a.x + b.x) / 2,
                my = (a.y + b.y) / 2,
                length = Math.hypot(mx, my) || 1;
              const x = mx + (mx / length) * 0.72,
                y = my + (my / length) * 0.72;
              return (
                <g
                  key={port.id}
                  className="port"
                  role="img"
                  aria-label={`${port.resource ? terrainLabels[port.resource] : "Generic"} ${port.ratio}:1 harbor. Build on either marked corner for this trade bonus.`}
                >
                  <circle
                    className="port-vertex-marker"
                    cx={a.x}
                    cy={a.y}
                    r=".12"
                  />
                  <circle
                    className="port-vertex-marker"
                    cx={b.x}
                    cy={b.y}
                    r=".12"
                  />
                  <path
                    className="port-pier"
                    d={`M${a.x} ${a.y} L${x} ${y} L${b.x} ${b.y}`}
                  />
                  <g transform={`translate(${x} ${y})`}>
                    <rect x="-.29" y="-.26" width=".58" height=".52" rx=".12" />
                    {port.resource ? (
                      <BoardIcon
                        terrain={port.resource}
                        x={0}
                        y={-0.08}
                        size={0.24}
                      />
                    ) : (
                      <text className="port-anchor" y="-.01">
                        ⚓
                      </text>
                    )}
                    <text className="port-ratio" y=".18">
                      {port.ratio}:1
                    </text>
                  </g>
                </g>
              );
            })}
          </g>
          <g className="pieces-layer">
            {Object.values(state.board.edges).map((edge) => {
              const owner =
                state.roads[edge.id] ??
                (roadBuildingSelectedEdges.includes(edge.id)
                  ? humanPlayerId
                  : undefined);
              if (!owner) return null;
              const a = state.board.vertices[edge.vertices[0]]!,
                b = state.board.vertices[edge.vertices[1]]!;
              return (
                <g
                  key={edge.id}
                  className="road-piece"
                  style={{ color: state.players[owner]?.color }}
                >
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                  <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 + 0.055}>
                    {playerCrest(state, owner)}
                  </text>
                </g>
              );
            })}
            {Object.values(state.board.vertices).map((vertex) => {
              const building = state.buildings[vertex.id];
              const owner =
                building?.owner ??
                state.settlements[vertex.id] ??
                (pendingSetupVertex === vertex.id ? humanPlayerId : undefined);
              if (!owner) return null;
              return (
                <g
                  key={vertex.id}
                  role={pendingSetupVertex === vertex.id ? "img" : undefined}
                  aria-label={
                    pendingSetupVertex === vertex.id
                      ? `Pending setup settlement at corner ${vertex.id}`
                      : undefined
                  }
                  className={`building house-building ${building?.type === "city" ? "city" : ""} ${pendingSetupVertex === vertex.id ? "pending" : ""}`}
                  style={{ color: state.players[owner]?.color }}
                  transform={`translate(${vertex.x} ${vertex.y})`}
                >
                  <BoardHousePiece city={building?.type === "city"} />
                  <text className="piece-crest" y=".1">
                    {playerCrest(state, owner)}
                  </text>
                </g>
              );
            })}
          </g>
          <g className="tokens-layer">
            {hexes.map((hex) => (
              <g key={hex.id} transform={`translate(${hex.x} ${hex.y + 0.35})`}>
                {hex.token ? (
                  <g className={`token token-${hex.token}`}>
                    <circle r={tokenRadius} />
                    <text y={tokenFontSize * 0.2} style={{ fontSize: tokenFontSize }}>{hex.token}</text>
                    <text className="probability" y={tokenRadius * 0.73} style={{ fontSize: tokenFontSize * 0.4 }}>
                      {"•".repeat(6 - Math.abs(7 - hex.token))}
                    </text>
                  </g>
                ) : (
                  <text className="desert-label">Dunes</text>
                )}
                {state.thiefHexId === hex.id ? (
                  <g
                    className="robber-piece"
                    transform="translate(0 -.75)"
                    role="img"
                    aria-label="Robber"
                  >
                    <circle cy="-.17" r=".13" />
                    <path d="M-.23 .24 Q-.18 -.1 0 -.08 Q.18 -.1 .23 .24Z" />
                    <path
                      className="robber-eyes"
                      d="M-.06 -.18h.03M.03 -.18h.03"
                    />
                  </g>
                ) : null}
              </g>
            ))}
          </g>
          <g className="targets-layer" aria-disabled={disabled}>
            {!disabled &&
              hexes
                .filter(
                  (hex) =>
                    legalThiefHexes.has(hex.id) && state.thiefHexId !== hex.id,
                )
                .map((hex) => (
                  <g
                    key={hex.id}
                    data-board-target
                    role="button"
                    tabIndex={0}
                    aria-label={
                      visibleStealTargets(hex.id).length
                        ? `Select robber destination on ${terrainLabels[hex.resource]} hex with steal targets`
                        : `Move robber to ${terrainLabels[hex.resource]} hex without stealing`
                    }
                    onKeyDown={(e) => activate(e, "hex", hex.id)}
                    onClick={(e) => selectFromPointer(e, "hex", hex.id)}
                  >
                    <polygon
                      className={`hex-target ${validSelection?.id === hex.id ? "selected" : ""}`}
                      points={hex.points}
                    />
                  </g>
                ))}
            {!disabled &&
              Object.values(state.board.edges)
                .filter(
                  (edge) =>
                    legalRoads.has(edge.id) ||
                    roadBuildingSelectedEdges.includes(edge.id),
                )
                .map((edge) => {
                  const a = state.board.vertices[edge.vertices[0]]!,
                    b = state.board.vertices[edge.vertices[1]]!;
                  return (
                    <g
                      key={edge.id}
                      className="edge-build-control"
                      data-board-target
                      role="button"
                      tabIndex={0}
                      aria-label="Build road here"
                      onKeyDown={(e) => activate(e, "edge", edge.id)}
                      onClick={(e) => selectFromPointer(e, "edge", edge.id)}
                    >
                      <line
                        className={`edge-build-target ${validSelection?.id === edge.id || roadBuildingSelectedEdges.includes(edge.id) ? "selected" : ""}`}
                        x1={(a.x * 3 + b.x) / 4}
                        y1={(a.y * 3 + b.y) / 4}
                        x2={(a.x + b.x * 3) / 4}
                        y2={(a.y + b.y * 3) / 4}
                      />
                      <circle
                        className="target-hit"
                        cx={(a.x + b.x) / 2}
                        cy={(a.y + b.y) / 2}
                        r={hitRadius}
                      />
                    </g>
                  );
                })}
            {!disabled &&
              Object.values(state.board.vertices)
                .filter(
                  (v) => legalSettlements.has(v.id) || legalCities.has(v.id),
                )
                .map((vertex) => (
                  <g
                    key={vertex.id}
                    className="vertex-target legal-target"
                    data-board-target
                    role="button"
                    tabIndex={0}
                    aria-label={`${legalCities.has(vertex.id) ? "Upgrade city" : state.phase.type === "SETUP_PLACEMENT" ? "Place setup settlement" : "Build settlement"} at corner ${vertex.id}`}
                    onKeyDown={(e) => activate(e, "vertex", vertex.id)}
                    onClick={(e) => selectFromPointer(e, "vertex", vertex.id)}
                  >
                    <circle
                      className={`vertex legal ${validSelection?.id === vertex.id ? "selected" : ""}`}
                      cx={vertex.x}
                      cy={vertex.y}
                      r=".105"
                    />
                    <circle
                      className="target-hit vertex-hit"
                      cx={vertex.x}
                      cy={vertex.y}
                      r={hitRadius}
                    />
                  </g>
                ))}
            {validSelection?.kind === "vertex" ? (
              <g
                className="placement-preview"
                transform={`translate(${state.board.vertices[validSelection.id]!.x} ${state.board.vertices[validSelection.id]!.y})`}
                style={{ color: state.players[humanPlayerId]?.color }}
                aria-hidden="true"
              >
                <BoardHousePiece city={legalCities.has(validSelection.id)} />
              </g>
            ) : null}
          </g>
        </g>
      </svg>
      <div className="board-camera-controls" aria-label="Board view">
        <button
          onClick={() => camera.zoom(1.3)}
          aria-label="Zoom in"
          disabled={camera.camera.scale >= 3}
        >
          +
        </button>
        <button
          onClick={() => camera.zoom(1 / 1.3)}
          aria-label="Zoom out"
          disabled={camera.camera.scale <= 1}
        >
          −
        </button>
        <button onClick={camera.fit}>Fit board</button>
      </div>
      {validSelection && !disabled ? (
        <div
          className="placement-confirmation" data-selection={validSelection.id}
          role="group"
          aria-label="Confirm placement"
        >
          <span>
            {validSelection.kind === "edge"
              ? "Place this road?"
              : validSelection.kind === "hex"
                ? "Move the robber here?"
                : legalCities.has(validSelection.id)
                  ? "Upgrade this village?"
                  : "Settle here?"}
          </span>
          <button className="primary-button" onClick={confirm}>
            Confirm placement
          </button>
          <button onClick={cancel}>Cancel</button>
        </div>
      ) : null}
      <div className="board-caption" aria-hidden="true">
        A little island. A world of possibilities.
      </div>
    </div>
  );
};
