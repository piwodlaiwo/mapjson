// Builds Cytoscape.js-format subgraphs from the bundled index: the containment
// chain around a focus entity, its children, and — the interesting part — its
// alias/identifier leaves including *co-claimants* (other entities that share
// the same name or code, e.g. "georgia" → GE + US-GA, "ma" → US-MA + Morocco).

const MAX_ENTITY_NODES = 400;

// Reverse lookups the index doesn't ship (children, names/identifiers per
// entity). Built once per index object, cached for the isolate lifetime.
const cacheByIndex = new WeakMap();

function getCaches(index) {
  let c = cacheByIndex.get(index);
  if (c) return c;
  const children = new Map();
  index.entities.forEach((e, idx) => {
    const parentIdx = e.parent != null ? index.gidIndex[e.parent] : null;
    if (parentIdx != null) {
      if (!children.has(parentIdx)) children.set(parentIdx, []);
      children.get(parentIdx).push(idx);
    }
  });
  const namesByEntity = new Map();
  index.names.forEach(([, postings], rowIdx) => {
    for (const [entityIdx] of postings) {
      if (!namesByEntity.has(entityIdx)) namesByEntity.set(entityIdx, []);
      namesByEntity.get(entityIdx).push(rowIdx);
    }
  });
  const identsByEntity = new Map();
  for (const [value, rows] of Object.entries(index.identifiers)) {
    for (const [, entityIdx] of rows) {
      if (!identsByEntity.has(entityIdx)) identsByEntity.set(entityIdx, []);
      identsByEntity.get(entityIdx).push(value);
    }
  }
  c = { children, namesByEntity, identsByEntity };
  cacheByIndex.set(index, c);
  return c;
}

export function buildGraph(index, gid, depth = 1) {
  const focusIdx = index.gidIndex[gid];
  if (focusIdx == null) return null;
  const { children, namesByEntity, identsByEntity } = getCaches(index);

  const nodes = new Map(); // node id -> element
  const edges = new Map(); // edge id -> element
  let truncated = false;

  const addEntity = (idx, role) => {
    const e = index.entities[idx];
    const existing = nodes.get(e.gid);
    if (existing) {
      // A co-claimant that is also e.g. an ancestor keeps its stronger role
      if (role === "focus") existing.data.role = "focus";
      return existing;
    }
    const el = {
      data: { id: e.gid, label: e.name, kind: "entity", layer: e.layer, role },
    };
    nodes.set(e.gid, el);
    return el;
  };
  const addEdge = (id, source, target, type) => {
    if (!edges.has(id)) edges.set(id, { data: { id, source, target, type } });
  };
  const contains = (parentGid, childGid) =>
    addEdge(`c:${parentGid}:${childGid}`, parentGid, childGid, "contains");

  addEntity(focusIdx, "focus");

  // Ancestor chain up to the root
  let cur = focusIdx;
  while (true) {
    const e = index.entities[cur];
    const parentIdx = e.parent != null ? index.gidIndex[e.parent] : null;
    if (parentIdx == null) break;
    addEntity(parentIdx, "ancestor");
    contains(index.entities[parentIdx].gid, e.gid);
    cur = parentIdx;
  }

  // Descendants, breadth-first to `depth`
  const queue = [[focusIdx, 0]];
  while (queue.length) {
    const [idx, d] = queue.shift();
    if (d >= depth) continue;
    for (const childIdx of children.get(idx) ?? []) {
      if (nodes.size >= MAX_ENTITY_NODES) { truncated = true; break; }
      addEntity(childIdx, "descendant");
      contains(index.entities[idx].gid, index.entities[childIdx].gid);
      queue.push([childIdx, d + 1]);
    }
  }

  // Alias and identifier leaves of the focus, with co-claimant entities
  for (const rowIdx of namesByEntity.get(focusIdx) ?? []) {
    const [norm, postings] = index.names[rowIdx];
    const nameId = `name:${norm}`;
    nodes.set(nameId, {
      data: { id: nameId, label: norm, kind: "alias", shared: postings.length > 1 },
    });
    for (const [entityIdx, nameType, source] of postings) {
      addEntity(entityIdx, entityIdx === focusIdx ? "focus" : "co-claimant");
      addEdge(
        `n:${norm}:${index.entities[entityIdx].gid}`,
        nameId, index.entities[entityIdx].gid,
        entityIdx === focusIdx ? `alias_${nameType}_${source}` : "alias_shared"
      );
    }
  }
  for (const value of identsByEntity.get(focusIdx) ?? []) {
    const rows = index.identifiers[value];
    const identId = `ident:${value}`;
    nodes.set(identId, {
      data: { id: identId, label: value, kind: "identifier", shared: rows.length > 1 },
    });
    for (const [scheme, entityIdx] of rows) {
      addEntity(entityIdx, entityIdx === focusIdx ? "focus" : "co-claimant");
      addEdge(
        `i:${value}:${scheme}:${index.entities[entityIdx].gid}`,
        identId, index.entities[entityIdx].gid,
        entityIdx === focusIdx ? `code_${scheme}` : "code_shared"
      );
    }
  }

  return {
    focus: gid,
    depth,
    truncated,
    elements: { nodes: [...nodes.values()], edges: [...edges.values()] },
  };
}
