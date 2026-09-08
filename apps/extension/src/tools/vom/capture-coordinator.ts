import {
  type CdpFrame,
  type CdpFrameGraph,
  type CdpTarget,
  cdpTargetKey,
} from "@/browser-driver/frame-graph";
import { cssViewport, GeometryContext } from "../geometry/frame-context";
import { type CdpRunner, cdpRunnerForTarget } from "../shared";
import { collectOverlayExcludedBackendIds } from "./capture";
import type { CapturedSceneInput } from "./facts";
import {
  buildDocumentIndex,
  type CaptureIssue,
  isCaptureAbort,
  type ObservationFacts,
  throwCaptureAborted,
} from "./facts";
import { enrichFormControlStates } from "./form-capture";
import {
  buildFrameDocuments,
  type FrameAxBatch,
  type FrameDocument,
  type FrameOwnedAxNode,
} from "./frame-document";
import { type NormalizedDocument, normalizeSnapshot } from "./normalize";
import { REQUESTED_STYLES, type SnapshotReply, snapshotFrameId } from "./snapshot";

interface TargetBatch<T extends FrameOwnedAxNode> {
  target: CdpTarget;
  frames: CdpFrame[];
  documents: NormalizedDocument[];
  ax: FrameAxBatch<T>[];
  fallbackExcluded: Set<number>;
}

/** A fixed worker pool scoped to one capture; each worker issues at most one
 * collection request at a time. Geometry has its own measurement-phase bound. */
async function collectTargets<T>(
  items: readonly T[],
  collect: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (cursor < items.length) {
        throwCaptureAborted(signal);
        const item = items[cursor++];
        await collect(item);
      }
    }),
  );
}

/** When topology discovery is unavailable, snapshot documents still carry
 * explicit target/frame provenance. Only explicit contentDocumentIndex edges
 * establish ancestry; a foreign frame is never renamed to fit a request. */
function snapshotFrames(snapshot: SnapshotReply, target: CdpTarget): CdpFrame[] {
  const raw = snapshot.documents ?? [];
  const strings = snapshot.strings ?? [];
  const frames = raw.map((doc) => {
    const frameId = snapshotFrameId(doc, strings);
    return frameId ? ({ frameId, target } as CdpFrame) : undefined;
  });
  for (let i = 0; i < raw.length; i++) {
    const edges = raw[i].nodes?.contentDocumentIndex;
    const parent = frames[i];
    if (!parent || !edges) continue;
    for (let e = 0; e < edges.index.length; e++) {
      const child = frames[edges.value[e]];
      const owner = raw[i].nodes?.backendNodeId?.[edges.index[e]];
      if (child && owner !== undefined && child !== parent) {
        child.parentFrameId = parent.frameId;
        child.ownerBackendNodeId = owner;
      }
    }
  }
  return frames.filter((frame): frame is CdpFrame => !!frame);
}

export async function captureObservationFacts<T extends FrameOwnedAxNode>(
  cdp: CdpRunner,
  tabId: number,
  signal?: AbortSignal,
): Promise<ObservationFacts<T>> {
  const startedAt = Date.now();
  throwCaptureAborted(signal);
  let graph: CdpFrameGraph | undefined;
  try {
    graph = await cdp.getFrameGraph?.(tabId);
  } catch (error) {
    if (isCaptureAbort(error)) throw error;
  }
  const geometry = new GeometryContext(cdp, tabId, graph, signal);
  const issues: CaptureIssue[] = [];
  const groups = new Map<string, TargetBatch<T>>();
  for (const frame of graph?.frames ?? []) {
    const key = cdpTargetKey(frame.target);
    let group = groups.get(key);
    if (!group) {
      group = {
        target: frame.target,
        frames: [],
        documents: [],
        ax: [],
        fallbackExcluded: new Set(),
      };
      groups.set(key, group);
    }
    group.frames.push(frame);
  }
  if (!groups.size)
    groups.set(cdpTargetKey({ tabId }), {
      target: { tabId },
      frames: [],
      documents: [],
      ax: [],
      fallbackExcluded: new Set(),
    });
  const batches = [...groups.values()];
  const unavailable = (batch: TargetBatch<T>, stage: CaptureIssue["stage"], frameId?: string) =>
    issues.push({ target: batch.target, frameId, stage, reason: "capture-unavailable" });
  let firstFailure: unknown;
  await collectTargets(
    batches,
    async (batch) => {
      const scoped = cdpRunnerForTarget(cdp, batch.target);
      try {
        throwCaptureAborted(signal);
        await scoped.send(tabId, "DOMSnapshot.enable", {});
        throwCaptureAborted(signal);
        const snapshot = await scoped.send<SnapshotReply>(tabId, "DOMSnapshot.captureSnapshot", {
          computedStyles: REQUESTED_STYLES,
          includePaintOrder: true,
          includeDOMRects: true,
        });
        throwCaptureAborted(signal);
        if (!graph) batch.frames = snapshotFrames(snapshot, batch.target);
        batch.documents = await normalizeSnapshot(
          snapshot,
          batch.target,
          batch.frames,
          geometry,
          issues,
          signal,
        );
        if (
          !(await enrichFormControlStates(
            scoped,
            tabId,
            batch.documents.map((doc) => doc.domNodes),
            signal,
          ))
        )
          unavailable(batch, "forms");
        const present = new Set(batch.documents.map((doc) => doc.frame.frameId));
        for (const frame of batch.frames)
          if (!present.has(frame.frameId)) unavailable(batch, "dom", frame.frameId);
      } catch (error) {
        if (isCaptureAbort(error)) throw error;
        firstFailure ??= error;
        unavailable(batch, "dom");
        batch.fallbackExcluded = await collectOverlayExcludedBackendIds(scoped, tabId, signal);
      }
      if (!batch.frames.length && !graph)
        batch.frames = [{ frameId: "root", target: batch.target }];
      try {
        throwCaptureAborted(signal);
        await scoped.send(tabId, "Accessibility.enable", {});
      } catch (error) {
        if (isCaptureAbort(error)) throw error;
        firstFailure ??= error;
        unavailable(batch, "ax");
        return;
      }
      for (const frame of batch.frames) {
        try {
          throwCaptureAborted(signal);
          const result = await scoped.send<{ nodes?: T[] }>(
            tabId,
            "Accessibility.getFullAXTree",
            frame.frameId === "root" ? {} : { frameId: frame.frameId },
          );
          batch.ax.push({ frame, nodes: result.nodes ?? [] });
        } catch (error) {
          if (isCaptureAbort(error)) throw error;
          firstFailure ??= error;
          unavailable(batch, "ax", frame.frameId);
        }
      }
    },
    signal,
  );

  const frames = batches.flatMap((batch) => batch.frames);
  const rootFrameId = graph?.rootFrameId ?? frames[0]?.frameId ?? "root";
  const decoded = new Map(
    batches.flatMap((batch) => batch.documents).map((doc) => [doc.frame.frameId, doc]),
  );
  const ax = batches.flatMap((batch) => batch.ax);
  const documents = await buildFrameDocuments(
    { rootFrameId, frames },
    ax,
    {
      nodes: [],
      rootFrameId,
      frameNodes: new Map([...decoded].map(([id, doc]) => [id, doc.domNodes])),
    },
    signal,
    (frame) =>
      issues.push({
        target: frame.target,
        frameId: frame.frameId,
        stage: "ownership",
        reason: "frame-ownership-unresolved",
      }),
  );
  let viewport = { width: 0, height: 0 };
  try {
    const measured = cssViewport(await geometry.layoutMetrics({ tabId }));
    viewport = { width: measured.width, height: measured.height };
  } catch (error) {
    if (isCaptureAbort(error)) throw error;
  }
  const facts: ObservationFacts<T>["documents"][number][] = [];
  for (const document of documents) {
    const doc = decoded.get(document.frameId);
    const index = doc?.index ?? (await buildDocumentIndex([], signal));
    const fallback = groups.get(cdpTargetKey(document.target))?.fallbackExcluded;
    const { domNodes, axNodes, contextScopeId: _scope, ...frame } = document;
    facts.push({
      frame,
      index: fallback?.size ? { ...index, excludedBackendNodeIds: fallback } : index,
      domNodes,
      axNodes,
    });
  }
  throwCaptureAborted(signal);
  if (firstFailure && facts.every((doc) => !doc.domNodes.length && !doc.axNodes.length))
    throw firstFailure;
  return { rootFrameId, viewport, documents: facts, issues, startedAt, finishedAt: Date.now() };
}

/** Existing semantic consumers get a narrow view; no raw snapshot
 * data can leak through recording's allowlisted output DTO. */
export function semanticCapture<T extends FrameOwnedAxNode>(
  facts: ObservationFacts<T>,
): { captured: CapturedSceneInput; documents: FrameDocument<T>[] } {
  const documents = facts.documents.map((doc) => ({
    ...doc.frame,
    contextScopeId: doc.frame.frameId,
    domNodes: doc.domNodes.filter(
      (node) => !doc.index.excludedBackendNodeIds.has(node.backendNodeId),
    ),
    axNodes: doc.axNodes,
    excludedBackendNodeIds: doc.index.excludedBackendNodeIds,
  }));
  const root = documents.find((doc) => doc.frameId === facts.rootFrameId);
  return {
    documents,
    captured: {
      nodes: root?.domNodes ?? [],
      viewport: facts.viewport,
      rootFrameId: facts.rootFrameId,
      excludedBackendNodeIds: root?.excludedBackendNodeIds ?? new Set(),
    },
  };
}
