// Coordinate DOMSnapshot acquisition, frame geometry and hover probes.
// Snapshot decoding and form enrichment live in their own modules.

import type { Viewport } from "@browser-skill/vom";
import type { CdpTarget } from "@/browser-driver/frame-graph";
import { evaluateHoverTrigger } from "@/lib/hover-trigger-policy";
import { OVERLAY_HOST_SELECTOR } from "../../lib/overlay-bridge";
import { type FrameProjectionIssue, type FrameProjectionState } from "../geometry/coordinate-types";
import { cssViewport, GeometryContext, type LayoutMetrics } from "../geometry/frame-context";
import type { CdpRunner } from "../shared";
import { isAbortError, throwIfAborted } from "./capture-abort";
import type { CapturedNode } from "./capture-types";
import { enrichFormControlStates } from "./form-capture";
import { clearHover, ProbeBudget, waitForHover } from "./hover-perception";
import { type FrameContext, normalizeDocument } from "./normalize";
import {
  REQUESTED_STYLES,
  type SnapshotDocument,
  type SnapshotReply,
  snapshotFrameId,
  sparseIndexMap,
} from "./snapshot";

export type { CapturedNode } from "./capture-types";

export type CapturedIframeNodes = Map<number, CapturedNode[]>;

export interface CapturedSurfaceProbe {
  triggerBackendNodeId: number;
  triggerPoint?: { x: number; y: number };
  triggerAction: "hover" | "focus" | string;
  subItems: string[];
  confidence?: "high" | "medium" | "low";
}

export interface CapturedViewModel {
  nodes: CapturedNode[];
  viewport: Viewport;
  iframeNodes: CapturedIframeNodes;
  frameNodes?: Map<string, CapturedNode[]>;
  frameExcludedBackendNodeIds?: Map<string, ReadonlySet<number>>;
  frameOwnerBackendNodeIds?: Map<string, number>;
  /** Explicit DOMSnapshot frame ancestry; never inferred from backend node ids. */
  frameParentIds?: Map<string, string>;
  rootFrameId?: string;
  /** Failed boundaries and descendants blocked by them; clipping is not a failure. */
  frameGeometryIssues?: FrameProjectionIssue[];
  /** Backend node ids belonging to the agent overlay host + its shadow subtree. */
  excludedBackendNodeIds: Set<number>;
}

export interface CaptureViewModelOptions {
  signal?: AbortSignal;
  geometry?: GeometryContext;
  target?: CdpTarget;
}

interface RuntimeEvaluateReply {
  result?: {
    value?: unknown;
  };
}

interface HoverCandidate {
  backendNodeId: number;
  label?: string;
  x: number;
  y: number;
  score: number;
  reasons: string[];
}

interface CdpDomNode {
  backendNodeId?: number;
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
}

function collectBackendIdsFromDomNode(node: CdpDomNode | undefined, out: Set<number>): void {
  if (!node) return;
  if (typeof node.backendNodeId === "number") {
    out.add(node.backendNodeId);
  }
  for (const child of node.children ?? []) {
    collectBackendIdsFromDomNode(child, out);
  }
  for (const shadow of node.shadowRoots ?? []) {
    collectBackendIdsFromDomNode(shadow, out);
  }
}

/**
 * Ceiling for the whole hover-surface phase.
 *
 * The previous 2000 was only a floor: the loop checked elapsed time at the top,
 * so a candidate could start with 1ms left and still run its two settle
 * windows, pushing real cost to ~2.6s. This is that true ceiling, now actually
 * enforced by an up-front affordability check, so the same number of candidates
 * get probed under a bound that no longer lies.
 */
const MAX_HOVER_PROBE_MS = 2_600;
const MAX_HOVER_TRIGGERS = 6;
const MAX_HOVER_SURFACES = 3;
const HOVER_SETTLE_MS = 300;
const MAX_HOVER_SUB_ITEMS = 12;

function runtimeValue<T>(reply: RuntimeEvaluateReply): T | undefined {
  return reply.result?.value as T | undefined;
}

function hoverCssTriggerScanExpression(): string {
  return `(() => {
    const visibilityProps = ["display", "visibility", "opacity", "maxHeight", "height", "overflow"];
    const centres = [];
    const seenRules = new Set();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (rule.type !== 1 || !rule.selectorText || !rule.style) continue;
        const selectorText = String(rule.selectorText);
        if (!selectorText.includes(":hover")) continue;
        if (!visibilityProps.some((prop) => rule.style[prop])) continue;
        for (const rawPart of selectorText.split(",")) {
          const part = rawPart.trim();
          const hoverIndex = part.indexOf(":hover");
          if (hoverIndex < 0) continue;
          const triggerSel = part.slice(0, hoverIndex).trim();
          if (!triggerSel) continue;
          if (seenRules.has(triggerSel)) continue;
          seenRules.add(triggerSel);
          let elements;
          try { elements = Array.from(document.querySelectorAll(triggerSel)); } catch { continue; }
          for (const el of elements) {
            if (!(el instanceof HTMLElement)) continue;
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none" || style.pointerEvents === "none") continue;
            centres.push({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            if (centres.length >= 24) return centres;
          }
        }
      }
    }
    return centres;
  })()`;
}

interface HoverRuntimeItem {
  text: string;
  role: string;
  tag: string;
  x: number;
  y: number;
}

function hoverStateExpression(): string {
  return `(() => {
    const items = [];
    const seen = new Set();
    const selectors = [
      "a",
      "button",
      "[role='menuitem']",
      "[role='menuitemcheckbox']",
      "[role='menuitemradio']",
      "[role='option']",
      "[role='tab']",
      "[role='link']",
      "[role='button']"
    ].join(",");
    const push = (el) => {
      if (!(el instanceof HTMLElement)) return;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return;
      const text = String(
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.textContent ||
        ""
      ).replace(/\\s+/g, " ").trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      items.push({
        text,
        role: (el.getAttribute("role") || "").toLowerCase(),
        tag: el.tagName.toLowerCase(),
        x: rect.left,
        y: rect.top,
      });
    };
    for (const el of Array.from(document.querySelectorAll(selectors))) push(el);
    return items.slice(0, 400);
  })()`;
}

function capturedText(node: CapturedNode): string | undefined {
  const value =
    node.attrs["aria-label"] ?? node.attrs.title ?? node.attrs.alt ?? node.textContent ?? "";
  const clean = value.replace(/\s+/g, " ").trim();
  return clean || undefined;
}

function hasGraphicDescendant(
  node: CapturedNode,
  childrenByParentId: Map<number, CapturedNode[]>,
  depth = 0,
): boolean {
  if (depth > 3) return false;
  for (const child of childrenByParentId.get(node.backendNodeId) ?? []) {
    const tag = child.tag.toLowerCase();
    if (["img", "svg", "use", "path", "i"].includes(tag)) return true;
    if (hasGraphicDescendant(child, childrenByParentId, depth + 1)) return true;
  }
  return false;
}

function roleOf(node: CapturedNode): string {
  return (node.attrs.role ?? "").toLowerCase();
}

function scoreHoverCandidate(
  node: CapturedNode,
  childrenByParentId: Map<number, CapturedNode[]>,
  cssHoverPoints: Array<{ x: number; y: number }>,
): HoverCandidate | null {
  const rect = node.rect;
  if (!rect) return null;
  const label = capturedText(node);
  const cssHoverMatch = cssHoverPoints.some(
    (point) =>
      point.x >= rect.x &&
      point.x <= rect.x + rect.w &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.h,
  );
  const decision = evaluateHoverTrigger({
    tag: node.tag,
    role: roleOf(node),
    label,
    attrs: node.attrs,
    rect,
    cursor: node.cursor,
    pointerEvents: node.pointerEvents,
    hasGraphicDescendant: hasGraphicDescendant(node, childrenByParentId),
    cssHoverMatch,
  });

  if (!decision.eligible) return null;
  return {
    backendNodeId: node.backendNodeId,
    label,
    x: rect.x + rect.w / 2,
    y: rect.y + rect.h / 2,
    score: decision.score,
    reasons: decision.reasons,
  };
}

function buildHoverCandidates(
  nodes: CapturedNode[],
  cssHoverPoints: Array<{ x: number; y: number }>,
): HoverCandidate[] {
  const childrenByParentId = new Map<number, CapturedNode[]>();
  const parentByBackendId = new Map<number, number | null>();
  for (const node of nodes) {
    parentByBackendId.set(node.backendNodeId, node.parentBackendNodeId);
    if (node.parentBackendNodeId === null) continue;
    const children = childrenByParentId.get(node.parentBackendNodeId) ?? [];
    children.push(node);
    childrenByParentId.set(node.parentBackendNodeId, children);
  }

  const candidates = nodes
    .map((node) => scoreHoverCandidate(node, childrenByParentId, cssHoverPoints))
    .filter((candidate): candidate is HoverCandidate => candidate !== null)
    .sort((a, b) => b.score - a.score);

  const deduped: HoverCandidate[] = [];
  const seen = new Set<number>();
  for (const candidate of candidates) {
    if (seen.has(candidate.backendNodeId)) continue;
    if (deduped.some((existing) => sameHoverCluster(existing, candidate, parentByBackendId))) {
      continue;
    }
    seen.add(candidate.backendNodeId);
    deduped.push(candidate);
    if (deduped.length >= MAX_HOVER_TRIGGERS) break;
  }
  return deduped;
}

function sameHoverCluster(
  a: HoverCandidate,
  b: HoverCandidate,
  parentByBackendId: Map<number, number | null>,
): boolean {
  if (Math.hypot(a.x - b.x, a.y - b.y) <= 8) return true;
  return (
    isBackendAncestor(a.backendNodeId, b.backendNodeId, parentByBackendId) ||
    isBackendAncestor(b.backendNodeId, a.backendNodeId, parentByBackendId)
  );
}

function isBackendAncestor(
  ancestorId: number,
  nodeId: number,
  parentByBackendId: Map<number, number | null>,
): boolean {
  let parentId = parentByBackendId.get(nodeId);
  let guard = 0;
  while (parentId !== null && parentId !== undefined && guard < parentByBackendId.size) {
    if (parentId === ancestorId) return true;
    parentId = parentByBackendId.get(parentId);
    guard += 1;
  }
  return false;
}

function diffHoverItems(before: HoverRuntimeItem[], after: HoverRuntimeItem[]): string[] {
  const beforeKeys = new Set(before.map((item) => item.text.toLowerCase()));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of after) {
    const text = item.text.replace(/\s+/g, " ").trim();
    const key = text.toLowerCase();
    if (!text || beforeKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_HOVER_SUB_ITEMS) break;
  }
  return out;
}

function confidenceForHover(
  candidate: HoverCandidate,
  subItems: string[],
): "high" | "medium" | "low" {
  if (subItems.length >= 2 && candidate.score >= 80) return "high";
  if (subItems.length >= 2 || candidate.score >= 80) return "medium";
  return "low";
}

/**
 * One candidate costs two settle windows (baseline + post-hover) plus a few
 * CDP round trips. Used to decide whether the next candidate still fits the
 * budget before paying for it.
 */
const HOVER_CANDIDATE_COST_MS = HOVER_SETTLE_MS * 2;

export interface HoverSurfaceProbeOptions {
  signal?: AbortSignal;
}

/**
 * Hovers a bounded set of likely menu triggers and reports the sub-items each
 * one reveals.
 *
 * Runs after DOM *and* accessibility capture. Hovering can open menus and
 * change layout, so probing between the two captures would leave the DOM half
 * of an observation describing the page before the change and the AX half
 * describing it after.
 *
 * The caller owns the overlay bypass span (see `withOverlayBypass`).
 */
export async function probeHoverSurfaces(
  cdp: CdpRunner,
  tabId: number,
  nodes: CapturedNode[],
  options: HoverSurfaceProbeOptions = {},
): Promise<CapturedSurfaceProbe[]> {
  const budget = new ProbeBudget(MAX_HOVER_PROBE_MS);
  try {
    throwIfAborted(options.signal);
    const cssScan = await cdp.send<RuntimeEvaluateReply>(tabId, "Runtime.evaluate", {
      expression: hoverCssTriggerScanExpression(),
      returnByValue: true,
    });
    throwIfAborted(options.signal);
    const cssHoverPoints = runtimeValue<Array<{ x: number; y: number }>>(cssScan) ?? [];
    const candidates = buildHoverCandidates(nodes, cssHoverPoints);
    if (candidates.length === 0) return [];

    const results: CapturedSurfaceProbe[] = [];
    const seen = new Set<number>();
    throwIfAborted(options.signal);
    for (const candidate of candidates.slice(0, MAX_HOVER_TRIGGERS)) {
      throwIfAborted(options.signal);
      if (!budget.canAfford(HOVER_CANDIDATE_COST_MS)) break;
      if (results.length >= MAX_HOVER_SURFACES) break;
      if (seen.has(candidate.backendNodeId)) continue;
      try {
        await clearHover(cdp, tabId);
        throwIfAborted(options.signal);
        await waitForHover(HOVER_SETTLE_MS, options.signal);
        const baselineReply = await cdp.send<RuntimeEvaluateReply>(tabId, "Runtime.evaluate", {
          expression: hoverStateExpression(),
          returnByValue: true,
        });
        throwIfAborted(options.signal);
        const baselineItems = runtimeValue<HoverRuntimeItem[]>(baselineReply) ?? [];

        throwIfAborted(options.signal);
        await cdp.send(tabId, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: candidate.x,
          y: candidate.y,
        });
        throwIfAborted(options.signal);
        await waitForHover(HOVER_SETTLE_MS, options.signal);
        const collected = await cdp.send<RuntimeEvaluateReply>(tabId, "Runtime.evaluate", {
          expression: hoverStateExpression(),
          returnByValue: true,
        });
        throwIfAborted(options.signal);
        const subItems = diffHoverItems(
          baselineItems,
          runtimeValue<HoverRuntimeItem[]>(collected) ?? [],
        );
        if (subItems.length === 0) continue;
        seen.add(candidate.backendNodeId);
        results.push({
          triggerBackendNodeId: candidate.backendNodeId,
          triggerPoint: { x: candidate.x, y: candidate.y },
          triggerAction: "hover",
          subItems,
          confidence: confidenceForHover(candidate, subItems),
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        continue;
      } finally {
        await clearHover(cdp, tabId);
      }
    }
    return results;
  } catch (err) {
    if (isAbortError(err)) throw err;
    console.debug("[bsk capture] hover surface probe failed", err);
    return [];
  }
}

/**
 * When DOMSnapshot is unavailable, locate the marked overlay host via CDP and
 * collect every backendNodeId in its pierced subtree (open shadow included).
 */
export async function collectOverlayExcludedBackendIds(
  cdp: CdpRunner,
  tabId: number,
  signal?: AbortSignal,
): Promise<Set<number>> {
  const excluded = new Set<number>();
  try {
    throwIfAborted(signal);
    const doc = await cdp.send<{ root?: { nodeId?: number } }>(tabId, "DOM.getDocument", {
      depth: 0,
      pierce: true,
    });
    throwIfAborted(signal);
    const rootNodeId = doc.root?.nodeId;
    if (typeof rootNodeId !== "number") return excluded;

    const found = await cdp.send<{ nodeId?: number }>(tabId, "DOM.querySelector", {
      nodeId: rootNodeId,
      selector: OVERLAY_HOST_SELECTOR,
    });
    throwIfAborted(signal);
    if (typeof found.nodeId !== "number" || found.nodeId === 0) return excluded;

    const described = await cdp.send<{ node?: CdpDomNode }>(tabId, "DOM.describeNode", {
      nodeId: found.nodeId,
      depth: -1,
      pierce: true,
    });
    throwIfAborted(signal);
    collectBackendIdsFromDomNode(described.node, excluded);
  } catch (err) {
    if (isAbortError(err)) throw err;
    console.debug("[bsk capture] overlay exclusion fallback failed", err);
  }
  return excluded;
}

interface ParseFrameDocumentsResult {
  frameGeometryIssues: FrameProjectionIssue[];
  iframeNodes: CapturedIframeNodes;
  frameOwnerBackendNodeIds: Map<string, number>;
  frameParentIds: Map<string, string>;
  frameExcludedBackendNodeIds: Map<string, ReadonlySet<number>>;
  excludedBackendNodeIds: Set<number>;
}

async function parseChildFrameDocuments(
  documents: SnapshotDocument[],
  strings: string[],
  parentDocIndex: number,
  parentContext: FrameContext,
  geometry: GeometryContext,
  signal?: AbortSignal,
  visited = new Set<number>(),
): Promise<ParseFrameDocumentsResult> {
  const frameGeometryIssues: FrameProjectionIssue[] = [];
  const iframeNodes: CapturedIframeNodes = new Map();
  const frameOwnerBackendNodeIds = new Map<string, number>();
  const frameParentIds = new Map<string, string>();
  const frameExcludedBackendNodeIds = new Map<string, ReadonlySet<number>>();
  const excludedBackendNodeIds = new Set<number>();
  const parentDoc = documents[parentDocIndex];
  const cdi = sparseIndexMap(parentDoc?.nodes?.contentDocumentIndex);
  if (cdi.size === 0) {
    return {
      iframeNodes,
      frameOwnerBackendNodeIds,
      frameParentIds,
      frameExcludedBackendNodeIds,
      excludedBackendNodeIds,
      frameGeometryIssues,
    };
  }

  const parentBackendIds = parentDoc?.nodes?.backendNodeId ?? [];

  const children = [...cdi].flatMap(([nodeArrayIdx, childDocIndex]) => {
    const childDoc = documents[childDocIndex];
    const iframeBackendId = parentBackendIds[nodeArrayIdx];
    if (visited.has(childDocIndex) || !childDoc || iframeBackendId === undefined) return [];
    const source = { target: parentContext.target, frameId: snapshotFrameId(childDoc, strings) };
    const parent = parentContext.projection;
    const projection: FrameProjectionState =
      parent.status === "available"
        ? { status: "unavailable", source, ownerBackendNodeId: iframeBackendId }
        : { status: "blocked", source, cause: parent.status === "blocked" ? parent.cause : parent };
    return [
      {
        childDocIndex,
        childDoc,
        iframeBackendId,
        source,
        projection: projection as FrameProjectionState,
      },
    ];
  });
  const parentProjection =
    parentContext.projection.status === "available"
      ? parentContext.projection.projection.geometry
      : null;
  if (parentProjection) {
    // Measure only direct siblings. Recursion starts after these workers finish,
    // so descendants never hold or recursively acquire a measurement slot.
    const edge = parentProjection.edges[0];
    const clips = edge
      ? [edge.destinationQuad, ...(edge.destinationClips ?? [])]
      : parentProjection.sourceClips;
    let cursor = 0;
    let failure: unknown;
    await Promise.all(
      Array.from({ length: Math.min(4, children.length) }, async () => {
        while (cursor < children.length && !signal?.aborted && !failure) {
          const child = children[cursor++];
          try {
            // Owner quads are target-relative; do not apply the parent transform twice.
            child.projection = await geometry.snapshotProjection(
              child.source,
              child.iframeBackendId,
              clips,
              parentProjection.topViewport,
            );
          } catch (error) {
            failure ??= error;
          }
        }
      }),
    );
    // Join all active reads, including object cleanup, before propagating abort.
    if (failure) throw failure;
  }
  throwIfAborted(signal);

  // Completion order must not change document traversal or result insertion order.
  for (const { childDocIndex, childDoc, iframeBackendId, source, projection } of children) {
    throwIfAborted(signal);
    if (projection.status !== "available") frameGeometryIssues.push(projection);
    const childContext: FrameContext = {
      frameId: source.frameId,
      target: source.target,
      ownerFrameBackendNodeId: iframeBackendId,
      projection,
      scrollX: childDoc.scrollOffsetX ?? 0,
      scrollY: childDoc.scrollOffsetY ?? 0,
    };
    const nextVisited = new Set(visited);
    nextVisited.add(childDocIndex);
    const parsed = await normalizeDocument(childDoc, strings, childContext, signal);
    iframeNodes.set(iframeBackendId, parsed.nodes);
    if (childContext.frameId) {
      frameOwnerBackendNodeIds.set(childContext.frameId, iframeBackendId);
      frameExcludedBackendNodeIds.set(childContext.frameId, parsed.index.excludedBackendNodeIds);
      if (parentContext.frameId) frameParentIds.set(childContext.frameId, parentContext.frameId);
    }
    for (const id of parsed.index.excludedBackendNodeIds) excludedBackendNodeIds.add(id);

    const nested = await parseChildFrameDocuments(
      documents,
      strings,
      childDocIndex,
      childContext,
      geometry,
      signal,
      nextVisited,
    );
    frameGeometryIssues.push(...nested.frameGeometryIssues);
    for (const [nestedFrameId, nestedNodes] of nested.iframeNodes) {
      iframeNodes.set(nestedFrameId, nestedNodes);
    }
    for (const [frameId, ownerBackendNodeId] of nested.frameOwnerBackendNodeIds) {
      frameOwnerBackendNodeIds.set(frameId, ownerBackendNodeId);
    }
    for (const [frameId, parentFrameId] of nested.frameParentIds) {
      frameParentIds.set(frameId, parentFrameId);
    }
    for (const [frameId, excluded] of nested.frameExcludedBackendNodeIds)
      frameExcludedBackendNodeIds.set(frameId, excluded);
    for (const id of nested.excludedBackendNodeIds) excludedBackendNodeIds.add(id);
  }

  return {
    iframeNodes,
    frameOwnerBackendNodeIds,
    frameParentIds,
    frameExcludedBackendNodeIds,
    excludedBackendNodeIds,
    frameGeometryIssues,
  };
}

export async function captureViewModel(
  cdp: CdpRunner,
  tabId: number,
  options: CaptureViewModelOptions = {},
): Promise<CapturedViewModel> {
  throwIfAborted(options.signal);
  const target = options.target ?? { tabId };
  const geometry = options.geometry ?? new GeometryContext(cdp, tabId, undefined, options.signal);
  let metrics: LayoutMetrics = {};
  try {
    metrics = await geometry.layoutMetrics(target);
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.debug("[bsk capture] layout metrics unavailable", error);
  }
  throwIfAborted(options.signal);
  const measured = cssViewport(metrics);
  const viewport: Viewport = { width: measured.width, height: measured.height };
  const scrollX = measured.scrollX;
  const scrollY = measured.scrollY;

  await cdp.send(tabId, "DOMSnapshot.enable", {});
  throwIfAborted(options.signal);
  const snap = await cdp.send<SnapshotReply>(tabId, "DOMSnapshot.captureSnapshot", {
    computedStyles: REQUESTED_STYLES,
    includePaintOrder: true,
    includeDOMRects: true,
  });
  throwIfAborted(options.signal);

  const strings = snap.strings ?? [];
  const documents = snap.documents ?? [];
  const doc0 = documents[0];
  if (!doc0?.nodes?.backendNodeId) {
    return {
      nodes: [],
      viewport,
      iframeNodes: new Map(),
      excludedBackendNodeIds: new Set(),
    };
  }

  const topContext: FrameContext = {
    frameId: snapshotFrameId(doc0, strings),
    ownerFrameBackendNodeId: null,
    target,
    projection: {
      status: "available",
      projection: {
        source: { target, frameId: snapshotFrameId(doc0, strings) },
        geometry: { sourceClips: [], edges: [], topViewport: viewport },
      },
    },
    scrollX,
    scrollY,
  };
  const mainParsed = await normalizeDocument(doc0, strings, topContext, options.signal);
  const nodes = mainParsed.nodes;
  const excludedBackendNodeIds = new Set(mainParsed.index.excludedBackendNodeIds);

  const ownerIds = new Set<number>();
  for (const document of documents) {
    for (const index of document.nodes?.contentDocumentIndex?.index ?? []) {
      const id = document.nodes?.backendNodeId?.[index];
      if (id !== undefined) ownerIds.add(id);
    }
  }
  geometry.registerSnapshotOwners(target, ownerIds);
  const frameParsed = await parseChildFrameDocuments(
    documents,
    strings,
    0,
    topContext,
    geometry,
    options.signal,
  );
  const iframeNodes = frameParsed.iframeNodes;
  if (topContext.frameId)
    frameParsed.frameExcludedBackendNodeIds.set(
      topContext.frameId,
      mainParsed.index.excludedBackendNodeIds,
    );
  for (const id of frameParsed.excludedBackendNodeIds) {
    excludedBackendNodeIds.add(id);
  }

  await enrichFormControlStates(cdp, tabId, [nodes, ...iframeNodes.values()], options.signal);
  throwIfAborted(options.signal);

  const frameNodes = new Map<string, CapturedNode[]>();
  if (topContext.frameId) frameNodes.set(topContext.frameId, nodes);
  for (const iframeFrameNodes of iframeNodes.values()) {
    const frameId = iframeFrameNodes.find((node) => node.frameId)?.frameId;
    if (frameId) frameNodes.set(frameId, iframeFrameNodes);
  }
  for (const [frameId, ownerBackendNodeId] of frameParsed.frameOwnerBackendNodeIds) {
    if (!frameNodes.has(frameId)) {
      frameNodes.set(frameId, iframeNodes.get(ownerBackendNodeId) ?? []);
    }
  }

  return {
    nodes,
    viewport,
    iframeNodes,
    frameNodes,
    frameGeometryIssues: frameParsed.frameGeometryIssues,
    frameOwnerBackendNodeIds: frameParsed.frameOwnerBackendNodeIds,
    frameExcludedBackendNodeIds: frameParsed.frameExcludedBackendNodeIds,
    frameParentIds: frameParsed.frameParentIds,
    ...(topContext.frameId ? { rootFrameId: topContext.frameId } : {}),
    excludedBackendNodeIds,
  };
}
