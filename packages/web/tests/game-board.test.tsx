// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDemoGame } from "@colonizt/demo-state";
import { GameBoard } from "../src/components/game-board.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  // Identity camera: isolate overlapping-target arbitration from browser geometry.
  vi.stubGlobal("DOMPoint", class { constructor(public x: number, public y: number) {} matrixTransform() { return { x: this.x, y: this.y }; } });
});
const game = createDemoGame("board-touch");
const props = () => ({ state: game, humanPlayerId: "p1", legalRoads: new Set<string>(), legalSettlements: new Set<string>(), legalCities: new Set<string>(), legalThiefHexes: new Set<string>(), pendingSetupVertex: null, roadBuildingSelectedEdges: [], disabled: false, onVertex: vi.fn(), onEdge: vi.fn(), onHex: vi.fn(), onCancel: vi.fn(), visibleStealTargets: () => [] });
const tap = (target: Element, x: number, y: number) => {
  Object.assign(target, { getScreenCTM: () => ({ inverse: () => ({}) }) });
  fireEvent.click(target, { detail: 1, clientX: x, clientY: y });
};
it("selects the nearest corner when another transparent touch target receives the tap", () => {
  const vertices = Object.values(game.board.vertices).slice(0, 2);
  const input = { ...props(), legalSettlements: new Set(vertices.map((v) => v.id)) };
  const { container } = render(<GameBoard {...input}/>);
  tap(screen.getAllByRole("button", { name: /Place setup settlement/ })[0]!, vertices[1]!.x, vertices[1]!.y);
  expect(container.querySelector(".placement-confirmation")).toHaveAttribute("data-selection", vertices[1]!.id);
  expect(input.onVertex).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm placement" }));
  expect(input.onVertex).toHaveBeenCalledExactlyOnceWith(vertices[1]!.id);
});
it("arbitrates overlapping roads and previews the nearest legal edge", () => {
  const edges = Object.values(game.board.edges).slice(0, 2);
  const input = { ...props(), legalRoads: new Set(edges.map((edge) => edge.id)) };
  render(<GameBoard {...input}/>);
  const a=game.board.vertices[edges[1]!.vertices[0]]!, b=game.board.vertices[edges[1]!.vertices[1]]!;
  tap(screen.getAllByRole("button", { name: "Build road here" })[0]!, (a.x+b.x)/2, (a.y+b.y)/2);
  fireEvent.click(screen.getByRole("button", { name: "Confirm placement" }));
  expect(input.onEdge).toHaveBeenCalledExactlyOnceWith(edges[1]!.id);
});
it("arbitrates robber destinations and cancels previews with Escape", () => {
  const hexes = Object.values(game.board.hexes).filter((hex) => hex.id !== game.thiefHexId).slice(0,2);
  const input = { ...props(), legalThiefHexes: new Set(hexes.map((hex) => hex.id)) };
  const { container } = render(<GameBoard {...input}/>);
  const vertices = game.board.adjacency.hexToVertices[hexes[1]!.id]!.map((id) => game.board.vertices[id]!);
  const target = screen.getAllByRole("button", { name: /Move robber to/ })[0]!;
  tap(target, vertices.reduce((total,v)=>total+v.x/6,0), vertices.reduce((total,v)=>total+v.y/6,0));
  expect(container.querySelector(".placement-confirmation")).toHaveAttribute("data-selection", hexes[1]!.id);
  fireEvent.keyDown(target, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Confirm placement" })).not.toBeInTheDocument();
  expect(input.onHex).not.toHaveBeenCalled();
  fireEvent.keyDown(target, { key: " " });
  fireEvent.click(screen.getByRole("button", { name: "Confirm placement" }));
  expect(input.onHex).toHaveBeenCalledExactlyOnceWith(hexes[0]!.id);
});

it.each(["Zoom in", "Zoom out", "Fit board", "Confirm placement", "Cancel"])("cancels a placement with Escape from %s", (control) => {
  const vertex = Object.values(game.board.vertices)[0]!;
  const input = { ...props(), legalSettlements: new Set([vertex.id]) };
  render(<GameBoard {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  fireEvent.keyDown(screen.getByRole("button", { name: /Place setup settlement/ }), { key: "Enter" });
  fireEvent.keyDown(screen.getByRole("button", { name: control }), { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Confirm placement" })).not.toBeInTheDocument();
  expect(input.onCancel).toHaveBeenCalledOnce();
  expect(input.onVertex).not.toHaveBeenCalled();
});
