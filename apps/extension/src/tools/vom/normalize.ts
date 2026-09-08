import type { CdpTarget } from "@/browser-driver/frame-graph";
import {
  type FrameProjectionState,
  projectSnapshotRect,
  type SnapshotCoordinates,
  snapshotViewportRect,
} from "../geometry/coordinate-types";
import { createCaptureCheckpoint } from "./capture-abort";
import { buildDocumentIndex, type DocumentIndex, type NodeFacts } from "./facts";
import { decodeDocument, type SnapshotDocument } from "./snapshot";

export interface FrameContext {
  frameId?: string;
  ownerFrameBackendNodeId: number | null;
  projection: FrameProjectionState;
  target: CdpTarget;
  coordinates: SnapshotCoordinates | null;
  layoutUnitsPerCssPixel: number | null;
}

export interface NormalizedDocument {
  nodes: NodeFacts[];
  index: DocumentIndex;
  documentElementBackendNodeId?: number;
}

/** Interpret one document using a supplied projection. No live reads or frame scheduling. */
export async function normalizeDocument(
  doc: SnapshotDocument,
  strings: string[],
  context: FrameContext,
  signal?: AbortSignal,
): Promise<NormalizedDocument> {
  const decoded = await decodeDocument(doc, strings, signal);
  const checkpoint = createCaptureCheckpoint(signal);
  const nodes: NodeFacts[] = [];
  for (let i = 0; i < decoded.nodes.length; i++) {
    if (i % 256 === 0) {
      const pending = checkpoint();
      if (pending) await pending;
    }
    const node = decoded.nodes[i];
    const bounds = node.layout?.bounds ?? [];
    const input = snapshotViewportRect(
      bounds,
      { target: context.target, frameId: context.frameId },
      context.coordinates,
    );
    const local = input?.rect;
    const rect =
      input && context.projection.status === "available"
        ? projectSnapshotRect(input, context.projection.projection)
        : null;
    const visibility = node.layout?.styles.visibility || "visible";
    const opacity = node.layout?.styles.opacity || "1";
    nodes.push({
      ...node,
      ...(context.frameId ? { frameId: context.frameId } : {}),
      ownerFrameBackendNodeId: context.ownerFrameBackendNodeId,
      localRect: local ? { x: local.x, y: local.y, w: local.width, h: local.height } : null,
      rect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
      rendered:
        bounds.length >= 4 &&
        bounds.slice(0, 4).every(Number.isFinite) &&
        bounds[2] > 0 &&
        bounds[3] > 0 &&
        visibility !== "hidden" &&
        visibility !== "collapse" &&
        (Number.parseFloat(opacity) || 0) > 0,
    });
  }
  const index = await buildDocumentIndex(nodes, signal);
  return {
    nodes: nodes.filter(
      (node) => !node.tag.startsWith("#") && !index.excludedBackendNodeIds.has(node.backendNodeId),
    ),
    index,
    documentElementBackendNodeId: nodes.find(
      (node) =>
        node.nodeType === 1 &&
        node.parentBackendNodeId !== null &&
        index.nodes.get(node.parentBackendNodeId)?.nodeType === 9,
    )?.backendNodeId,
  };
}
