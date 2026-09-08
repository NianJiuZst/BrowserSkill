import type { Viewport } from "@browser-skill/vom";
import type { CdpFrame, CdpTarget } from "@/browser-driver/frame-graph";
import { type GeometryProjection, projectRectToViewport } from "../geometry";
import {
  type FrameProjectionState,
  projectSnapshotRect,
  snapshotViewportRect,
} from "../geometry/coordinate-types";
import { cssViewport, GeometryContext } from "../geometry/frame-context";
import type { CapturedNode } from "./facts";
import {
  buildDocumentIndex,
  type CaptureIssue,
  captureCheckpoint,
  type DocumentIndex,
  isCaptureAbort,
  type NodeFacts,
  throwCaptureAborted,
} from "./facts";
import {
  decodeDocument,
  type SnapshotDocument,
  type SnapshotReply,
  snapshotFrameId,
} from "./snapshot";

export interface NormalizedDocument {
  index: DocumentIndex;
  frame: CdpFrame;
  domNodes: CapturedNode[];
}

/** One target's snapshot. Source ownership is checked before interpreting any
 * coordinates. Snapshot and live quad coordinates are deliberately not conflated. */
export async function normalizeSnapshot(
  snapshot: SnapshotReply,
  target: CdpTarget,
  frames: readonly CdpFrame[],
  geometry: GeometryContext,
  issues: CaptureIssue[],
  signal?: AbortSignal,
): Promise<NormalizedDocument[]> {
  const strings = snapshot.strings ?? [];
  const raw = snapshot.documents ?? [];
  const frameById = new Map(frames.map((frame) => [frame.frameId, frame]));
  const sources = new Map<string, SnapshotDocument>();
  for (const doc of raw) {
    const id = snapshotFrameId(doc, strings);
    if (!id || !frameById.has(id) || sources.has(id)) {
      issues.push({
        target,
        frameId: id,
        stage: "ownership",
        reason: "frame-ownership-unresolved",
      });
      continue;
    }
    sources.set(id, doc);
  }
  let viewport: Viewport = { width: 0, height: 0 };
  let scrollX = 0,
    scrollY = 0;
  try {
    const measured = cssViewport(await geometry.layoutMetrics(target));
    viewport = { width: measured.width, height: measured.height };
    scrollX = measured.scrollX;
    scrollY = measured.scrollY;
  } catch (error) {
    if (isCaptureAbort(error)) throw error;
  }

  const children = new Map<string, CdpFrame[]>();
  const pending: CdpFrame[] = [];
  for (const frame of frames) {
    if (!frame.parentFrameId || !frameById.has(frame.parentFrameId)) pending.push(frame);
    else {
      const siblings = children.get(frame.parentFrameId);
      if (siblings) siblings.push(frame);
      else children.set(frame.parentFrameId, [frame]);
    }
  }
  const projections = new Map<string, FrameProjectionState | null>();
  const result: NormalizedDocument[] = [];
  let targetProjection: GeometryProjection | null = null;
  const targetRoot = pending[0];
  if (target.sessionId && targetRoot) {
    try {
      targetProjection = await geometry.targetProjection(targetRoot.frameId);
    } catch (error) {
      if (isCaptureAbort(error)) throw error;
    }
  }
  for (let cursor = 0; cursor < pending.length; cursor++) {
    if (cursor % 256 === 0) await captureCheckpoint(signal);
    const frame = pending[cursor];
    for (const child of children.get(frame.frameId) ?? []) pending.push(child);
    const doc = sources.get(frame.frameId);
    if (!doc) continue;
    const source = { target, frameId: frame.frameId };
    const parent = frame.parentFrameId ? frameById.get(frame.parentFrameId) : undefined;
    const state: FrameProjectionState | null = !parent
      ? {
          status: "available",
          projection: { source, geometry: { sourceClips: [], edges: [], topViewport: viewport } },
        }
      : (projections.get(frame.frameId) ?? null);
    projections.set(frame.frameId, state);
    const projection = state?.status === "available" ? state.projection : null;
    if (!projection || (target.sessionId && !targetProjection))
      issues.push({
        target,
        frameId: frame.frameId,
        stage: "geometry",
        reason: "geometry-unavailable",
        ...(state && state.status !== "available" ? { projectionIssue: state } : {}),
      });

    // Only direct siblings share this pool. Keep normalization in its existing
    // breadth-first order, independent of owner read completion order.
    const siblings = (children.get(frame.frameId) ?? []).filter((child) =>
      sources.has(child.frameId),
    );
    const edge = projection?.geometry.edges[0];
    const clips = edge
      ? [edge.destinationQuad, ...(edge.destinationClips ?? [])]
      : (projection?.geometry.sourceClips ?? []);
    let next = 0;
    let failure: unknown;
    await Promise.all(
      Array.from({ length: Math.min(4, siblings.length) }, async () => {
        while (next < siblings.length && !signal?.aborted && !failure) {
          const child = siblings[next++];
          const childSource = { target, frameId: child.frameId };
          if (!projection) {
            projections.set(
              child.frameId,
              state && state.status !== "available"
                ? {
                    status: "blocked",
                    source: childSource,
                    cause: state.status === "blocked" ? state.cause : state,
                  }
                : null,
            );
            continue;
          }
          if (child.ownerBackendNodeId === undefined) {
            projections.set(child.frameId, null);
            continue;
          }
          try {
            projections.set(
              child.frameId,
              await geometry.snapshotProjection(
                childSource,
                child.ownerBackendNodeId,
                clips,
                viewport,
              ),
            );
          } catch (error) {
            failure ??= error;
          }
        }
      }),
    );
    // Join active reads and their cleanup before returning cancellation.
    if (failure) throw failure;
    throwCaptureAborted(signal);
    const decoded = await decodeDocument(doc, strings, signal);
    const nodes: NodeFacts[] = [];
    for (let i = 0; i < decoded.nodes.length; i++) {
      if (i % 256 === 0) await captureCheckpoint(signal);
      const node = decoded.nodes[i];
      const input = snapshotViewportRect(node.layout?.bounds ?? [], source, {
        x: doc.scrollOffsetX ?? (parent ? 0 : scrollX),
        y: doc.scrollOffsetY ?? (parent ? 0 : scrollY),
      });
      const local = input?.rect;
      let rect = input && projection ? projectSnapshotRect(input, projection) : null;
      if (rect && target.sessionId)
        rect = targetProjection
          ? projectRectToViewport(
              { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
              targetProjection,
            )
          : null;
      const styles = node.layout?.styles;
      const visibility = styles?.visibility || "visible";
      const opacity = styles?.opacity || "1";
      nodes.push({
        ...node,
        frameId: frame.frameId,
        ownerFrameBackendNodeId: frame.ownerBackendNodeId ?? null,
        localRect: local ? { x: local.x, y: local.y, w: local.width, h: local.height } : null,
        rect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
        rendered:
          !!local &&
          visibility !== "hidden" &&
          visibility !== "collapse" &&
          (Number.parseFloat(opacity) || 0) > 0,
      });
    }
    const index = await buildDocumentIndex(nodes, signal);
    const domNodes = nodes.filter((node) => !node.tag.startsWith("#"));
    result.push({
      index,
      frame,
      domNodes,
    });
  }
  for (const frameId of sources.keys()) {
    if (!projections.has(frameId))
      issues.push({ target, frameId, stage: "ownership", reason: "frame-ownership-unresolved" });
  }
  return result;
}
