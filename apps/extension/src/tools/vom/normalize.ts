import type { CdpTarget } from "@/browser-driver/frame-graph";
import {
  type FrameProjectionState,
  projectSnapshotRect,
  snapshotViewportRect,
} from "../geometry/coordinate-types";
import { captureCheckpoint } from "./capture-abort";
import { buildDocumentIndex, type DocumentIndex, type NodeFacts } from "./facts";
import { decodeDocument, type SnapshotDocument } from "./snapshot";

export interface FrameContext {
  frameId?: string;
  ownerFrameBackendNodeId: number | null;
  projection: FrameProjectionState;
  target: CdpTarget;
  scrollX: number;
  scrollY: number;
}

export interface NormalizedDocument {
  nodes: NodeFacts[];
  index: DocumentIndex;
}

/** Interpret one document using a supplied projection. No live reads or frame scheduling. */
export async function normalizeDocument(
  doc: SnapshotDocument,
  strings: string[],
  context: FrameContext,
  signal?: AbortSignal,
): Promise<NormalizedDocument> {
  const decoded = await decodeDocument(doc, strings, signal);
  const nodes: NodeFacts[] = [];
  for (let i = 0; i < decoded.nodes.length; i++) {
    if (i % 256 === 0) await captureCheckpoint(signal);
    const node = decoded.nodes[i];
    const input = snapshotViewportRect(
      node.layout?.bounds ?? [],
      { target: context.target, frameId: context.frameId },
      { x: context.scrollX, y: context.scrollY },
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
        !!local &&
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
  };
}
