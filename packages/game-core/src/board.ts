import { seededShuffle } from "./rng.js";
import { resources, type BoardGraph, type EdgeId, type HexId, type Resource, type Terrain, type VertexId } from "./types.js";

interface HexSpec {
  q: number;
  r: number;
  resource: Terrain;
  token?: number;
}

const isResource = (terrain: Terrain): terrain is Resource => resources.includes(terrain as Resource);

const classicTerrainDeck: Terrain[] = [
  "desert",
  "timber", "timber", "timber", "timber",
  "brick", "brick", "brick",
  "grain", "grain", "grain", "grain",
  "fiber", "fiber", "fiber", "fiber",
  "ore", "ore", "ore",
];

const classicTokenDeck = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

const redTokens = new Set([6, 8]);

const axialDistance = (left: { q: number; r: number }, right: { q: number; r: number }): number => {
  const leftS = -left.q - left.r;
  const rightS = -right.q - right.r;
  return (Math.abs(left.q - right.q) + Math.abs(left.r - right.r) + Math.abs(leftS - rightS)) / 2;
};

const adjacentCoordinatePairs = (coords: readonly { q: number; r: number }[]): Array<[number, number]> => {
  const pairs: Array<[number, number]> = [];
  for (let left = 0; left < coords.length; left += 1) {
    for (let right = left + 1; right < coords.length; right += 1) {
      if (axialDistance(coords[left]!, coords[right]!) === 1) pairs.push([left, right]);
    }
  }
  return pairs;
};

const scoreTerrainLayout = (
  coords: readonly { q: number; r: number }[],
  terrain: readonly Terrain[],
): number => {
  let score = 0;
  for (const [left, right] of adjacentCoordinatePairs(coords)) {
    const leftTerrain = terrain[left];
    const rightTerrain = terrain[right];
    if (!leftTerrain || !rightTerrain || leftTerrain === "desert" || rightTerrain === "desert") continue;
    if (leftTerrain === rightTerrain) score += 8;
  }
  for (const resource of resources) {
    const indexes = terrain.flatMap((candidate, index) => candidate === resource ? [index] : []);
    const adjacentCount = indexes.reduce((count, left, index) =>
      count + indexes.slice(index + 1).filter((right) => axialDistance(coords[left]!, coords[right]!) === 1).length,
    0);
    score += Math.max(0, adjacentCount - 1) * 2;
  }
  return score;
};

const balancedTerrainDeck = (coords: readonly { q: number; r: number }[], seed: string): Terrain[] => {
  let best = classicTerrainDeck;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const candidate = seededShuffle<Terrain>(classicTerrainDeck, `${seed}:resources:${attempt}`);
    const score = scoreTerrainLayout(coords, candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
      if (score === 0) break;
    }
  }
  return best;
};

const scoreTokenLayout = (
  coords: readonly { q: number; r: number }[],
  terrain: readonly Terrain[],
  tokensByCoord: readonly (number | undefined)[],
): number => {
  let score = 0;
  for (const [left, right] of adjacentCoordinatePairs(coords)) {
    const leftToken = tokensByCoord[left];
    const rightToken = tokensByCoord[right];
    if (leftToken && rightToken && redTokens.has(leftToken) && redTokens.has(rightToken)) score += 1_000;
  }
  for (const resource of resources) {
    const redCount = terrain.reduce((count, candidate, index) =>
      count + (candidate === resource && redTokens.has(tokensByCoord[index] ?? 0) ? 1 : 0),
    0);
    score += Math.max(0, redCount - 1) * 12;
  }
  return score;
};

const balancedTokenDeck = (
  coords: readonly { q: number; r: number }[],
  terrain: readonly Terrain[],
  seed: string,
): number[] => {
  const productiveIndexes = terrain.flatMap((candidate, index) => candidate === "desert" ? [] : [index]);
  let best = classicTokenDeck;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const candidate = seededShuffle(classicTokenDeck, `${seed}:tokens:${attempt}`);
    const tokensByCoord = Array<number | undefined>(coords.length).fill(undefined);
    productiveIndexes.forEach((coordIndex, tokenIndex) => {
      tokensByCoord[coordIndex] = candidate[tokenIndex];
    });
    const score = scoreTokenLayout(coords, terrain, tokensByCoord);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
      if (score === 0) break;
    }
  }
  return best;
};

const cornerKey = (x: number, y: number): string => `${Math.round(x * 1000) / 1000},${Math.round(y * 1000) / 1000}`;

const parseKey = (key: string): { x: number; y: number } => {
  const [x, y] = key.split(",").map(Number);
  return { x: x ?? 0, y: y ?? 0 };
};

const hexCenter = (q: number, r: number): { x: number; y: number } => ({
  x: Math.sqrt(3) * (q + r / 2),
  y: 1.5 * r,
});

const hexCornerKeys = (q: number, r: number): string[] => {
  const center = hexCenter(q, r);
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (30 + index * 60);
    return cornerKey(center.x + Math.cos(angle), center.y + Math.sin(angle));
  });
};

export const createBoardFromHexes = (hexSpecs: HexSpec[]): BoardGraph => {
  const vertexHexes = new Map<string, Set<HexId>>();
  const edgeHexes = new Map<string, { keys: [string, string]; hexes: Set<HexId> }>();
  const hexCornerMap = new Map<HexId, string[]>();

  const hexes = Object.fromEntries(
    hexSpecs.map((spec, index) => {
      const id = `h${index}` as HexId;
      const corners = hexCornerKeys(spec.q, spec.r);
      hexCornerMap.set(id, corners);
      for (const key of corners) {
        const adjacent = vertexHexes.get(key) ?? new Set<HexId>();
        adjacent.add(id);
        vertexHexes.set(key, adjacent);
      }
      for (let corner = 0; corner < corners.length; corner += 1) {
        const a = corners[corner] as string;
        const b = corners[(corner + 1) % corners.length] as string;
        const sorted = [a, b].sort() as [string, string];
        const edgeKey = `${sorted[0]}|${sorted[1]}`;
        const existing = edgeHexes.get(edgeKey) ?? { keys: sorted, hexes: new Set<HexId>() };
        existing.hexes.add(id);
        edgeHexes.set(edgeKey, existing);
      }
      return [id, { id, ...spec }];
    }),
  ) as BoardGraph["hexes"];

  const vertexKeys = [...vertexHexes.keys()].sort();
  const keyToVertex = new Map<string, VertexId>();
  const vertices: BoardGraph["vertices"] = {};
  vertexKeys.forEach((key, index) => {
    const id = `v${index}` as VertexId;
    keyToVertex.set(key, id);
    const { x, y } = parseKey(key);
    vertices[id] = { id, x, y, adjacentHexes: [...(vertexHexes.get(key) ?? [])].sort() };
  });

  const edges: BoardGraph["edges"] = {};
  const edgeToVertices: Record<EdgeId, [VertexId, VertexId]> = {};
  const vertexToEdges: Record<VertexId, EdgeId[]> = Object.fromEntries(
    Object.keys(vertices).map((id) => [id, []]),
  ) as Record<VertexId, EdgeId[]>;

  [...edgeHexes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([, value], index) => {
      const id = `e${index}` as EdgeId;
      const verticesForEdge = [keyToVertex.get(value.keys[0]), keyToVertex.get(value.keys[1])] as [VertexId, VertexId];
      edges[id] = { id, vertices: verticesForEdge, adjacentHexes: [...value.hexes].sort() };
      edgeToVertices[id] = verticesForEdge;
      vertexToEdges[verticesForEdge[0]]?.push(id);
      vertexToEdges[verticesForEdge[1]]?.push(id);
    });

  const hexToVertices: Record<HexId, VertexId[]> = {};
  for (const [hexId, keys] of hexCornerMap.entries()) {
    hexToVertices[hexId] = keys.map((key) => keyToVertex.get(key) as VertexId);
  }

  const portSpecs: Array<{ ratio: 2 | 3; resource?: Resource }> = [
    { ratio: 3 },
    { ratio: 2, resource: "timber" },
    { ratio: 3 },
    { ratio: 2, resource: "brick" },
    { ratio: 3 },
    { ratio: 2, resource: "fiber" },
    { ratio: 3 },
    { ratio: 2, resource: "grain" },
    { ratio: 2, resource: "ore" },
  ];
  const coastEdges = Object.values(edges)
    .filter((edge) => edge.adjacentHexes.length === 1)
    .sort((left, right) => {
      const leftA = vertices[left.vertices[0]]!;
      const leftB = vertices[left.vertices[1]]!;
      const rightA = vertices[right.vertices[0]]!;
      const rightB = vertices[right.vertices[1]]!;
      const leftAngle = Math.atan2((leftA.y + leftB.y) / 2, (leftA.x + leftB.x) / 2);
      const rightAngle = Math.atan2((rightA.y + rightB.y) / 2, (rightA.x + rightB.x) / 2);
      return leftAngle - rightAngle || left.id.localeCompare(right.id);
    });
  const maxPorts = Math.min(portSpecs.length, coastEdges.length);
  const ports: BoardGraph["ports"] = {};
  for (let index = 0; index < maxPorts; index += 1) {
    const edge = coastEdges[Math.floor((index * coastEdges.length) / maxPorts)]!;
    const spec = portSpecs[index]!;
    ports[`p${index}`] = {
      id: `p${index}`,
      edgeId: edge.id,
      vertexIds: edge.vertices,
      ...spec,
    };
  }

  return {
    hexes,
    vertices,
    edges,
    ports,
    adjacency: {
      hexToVertices,
      vertexToEdges,
      edgeToVertices,
    },
  };
};

export const createSeededBoard = (seed: string, radius = 1): BoardGraph => {
  const coords: Array<{ q: number; r: number }> = [];
  for (let q = -radius; q <= radius; q += 1) {
    for (let r = -radius; r <= radius; r += 1) {
      const s = -q - r;
      if (Math.abs(s) <= radius) {
        coords.push({ q, r });
      }
    }
  }
  const terrainDeck = coords.length === classicTerrainDeck.length
    ? balancedTerrainDeck(coords, seed)
    : seededShuffle<Terrain>(
      [
        "desert",
        ...Array.from({ length: Math.max(0, coords.length - 1) }, (_, index) => resources[index % resources.length] as Resource),
      ],
      `${seed}:resources`,
    );
  const tokenDeck = coords.length === classicTerrainDeck.length
    ? balancedTokenDeck(coords, terrainDeck, seed)
    : seededShuffle(classicTokenDeck, `${seed}:tokens`);
  let tokenIndex = 0;
  return createBoardFromHexes(
    coords.map((coord, index) => {
      const resource = terrainDeck[index] ?? "grain";
      const token = resource === "desert" ? undefined : tokenDeck[tokenIndex % tokenDeck.length] ?? 6;
      if (resource !== "desert") tokenIndex += 1;
      return {
        ...coord,
        resource,
        ...(token ? { token } : {}),
      };
    }),
  );
};

export const createFixedBoard = (): BoardGraph => createSeededBoard("fixed-board", 2);

const resourceDistributionErrors = (board: BoardGraph): string[] => {
  if (Object.keys(board.hexes).length !== classicTerrainDeck.length) return [];
  const errors: string[] = [];
  const expectedTerrainCounts = classicTerrainDeck.reduce<Record<Terrain, number>>((counts, terrain) => {
    counts[terrain] = (counts[terrain] ?? 0) + 1;
    return counts;
  }, { desert: 0, timber: 0, brick: 0, grain: 0, fiber: 0, ore: 0 });
  const actualTerrainCounts = Object.values(board.hexes).reduce<Record<Terrain, number>>((counts, hex) => {
    counts[hex.resource] = (counts[hex.resource] ?? 0) + 1;
    return counts;
  }, { desert: 0, timber: 0, brick: 0, grain: 0, fiber: 0, ore: 0 });
  for (const terrain of [...resources, "desert"] as Terrain[]) {
    if (actualTerrainCounts[terrain] !== expectedTerrainCounts[terrain]) {
      errors.push(`classic board has ${actualTerrainCounts[terrain]} ${terrain} tiles, expected ${expectedTerrainCounts[terrain]}`);
    }
  }

  const coordToHex = new Map(Object.values(board.hexes).map((hex) => [`${hex.q},${hex.r}`, hex]));
  for (const hex of Object.values(board.hexes)) {
    if (!hex.token || !redTokens.has(hex.token)) continue;
    const neighbors = [
      { q: hex.q + 1, r: hex.r },
      { q: hex.q - 1, r: hex.r },
      { q: hex.q, r: hex.r + 1 },
      { q: hex.q, r: hex.r - 1 },
      { q: hex.q + 1, r: hex.r - 1 },
      { q: hex.q - 1, r: hex.r + 1 },
    ];
    for (const neighborCoord of neighbors) {
      const neighbor = coordToHex.get(`${neighborCoord.q},${neighborCoord.r}`);
      if (neighbor?.token && redTokens.has(neighbor.token)) {
        errors.push(`classic board has adjacent red tokens at ${hex.id} and ${neighbor.id}`);
      }
    }
  }
  return errors;
};

export const validateBoard = (board: BoardGraph): string[] => {
  const errors: string[] = [];
  errors.push(...resourceDistributionErrors(board));
  for (const [hexId, hex] of Object.entries(board.hexes)) {
    if (hex.resource !== "desert" && !isResource(hex.resource)) errors.push(`hex ${hexId} has invalid resource`);
    if (hex.resource === "desert" && hex.token !== undefined) {
      errors.push(`hex ${hexId} desert cannot have token`);
    }
    if (hex.resource !== "desert" && (!Number.isInteger(hex.token) || hex.token! < 2 || hex.token! > 12 || hex.token === 7)) {
      errors.push(`hex ${hexId} has invalid token`);
    }
    if ((board.adjacency.hexToVertices[hexId] ?? []).length !== 6) {
      errors.push(`hex ${hexId} does not have six vertices`);
    }
  }
  for (const [vertexId, vertex] of Object.entries(board.vertices)) {
    for (const hexId of vertex.adjacentHexes) {
      if (!board.hexes[hexId]) errors.push(`vertex ${vertexId} references unknown hex ${hexId}`);
    }
    for (const edgeId of board.adjacency.vertexToEdges[vertexId] ?? []) {
      if (!board.edges[edgeId]) errors.push(`vertex ${vertexId} references unknown edge ${edgeId}`);
    }
  }
  for (const [edgeId, edge] of Object.entries(board.edges)) {
    if (edge.vertices.length !== 2 || !board.vertices[edge.vertices[0]] || !board.vertices[edge.vertices[1]]) {
      errors.push(`edge ${edgeId} has invalid endpoints`);
    }
    const adjacency = board.adjacency.edgeToVertices[edgeId];
    if (!adjacency || adjacency[0] !== edge.vertices[0] || adjacency[1] !== edge.vertices[1]) {
      errors.push(`edge ${edgeId} adjacency mismatch`);
    }
  }
  for (const [portId, port] of Object.entries(board.ports ?? {})) {
    const edge = board.edges[port.edgeId];
    if (!edge) errors.push(`port ${portId} references unknown edge ${port.edgeId}`);
    if (edge && edge.adjacentHexes.length !== 1) errors.push(`port ${portId} is not on a coast edge`);
    if (edge && (edge.vertices[0] !== port.vertexIds[0] || edge.vertices[1] !== port.vertexIds[1])) errors.push(`port ${portId} vertices do not match edge`);
    if (!board.vertices[port.vertexIds[0]] || !board.vertices[port.vertexIds[1]]) errors.push(`port ${portId} has invalid vertices`);
    if (![2, 3].includes(port.ratio)) errors.push(`port ${portId} has invalid ratio`);
    if (port.resource && !resources.includes(port.resource)) errors.push(`port ${portId} has invalid resource`);
    if (port.resource && port.ratio !== 2) errors.push(`port ${portId} resource ports must be 2:1`);
    if (!port.resource && port.ratio !== 3) errors.push(`port ${portId} generic ports must be 3:1`);
  }
  if (Object.keys(board.vertices).length < 8 || Object.keys(board.edges).length < 8) {
    errors.push("board is too small to be playable");
  }
  return errors;
};
