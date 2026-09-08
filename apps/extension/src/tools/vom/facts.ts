import type { CdpTarget } from "@/browser-driver/frame-graph";
import { isOverlayHostNode } from "@/lib/overlay-bridge";
import { createCaptureCheckpoint } from "./capture-abort";
import type { CapturedNode } from "./capture-types";

/** Bounds retain their raw snapshot document layout units until normalization. */
export interface SnapshotLayout {
  readonly boundsSpace: "snapshot-document-layout";
  bounds?: number[];
  styles: Readonly<Record<string, string>>;
}

export interface DecodedNode extends Omit<CapturedNode, "rect" | "localRect" | "rendered"> {
  nodeType?: number;
  layout?: SnapshotLayout;
}

export interface NodeFacts extends CapturedNode {
  nodeType?: number;
  layout?: SnapshotLayout;
}

export interface DocumentIndex<T extends DecodedNode = NodeFacts> {
  readonly nodes: ReadonlyMap<number, T>;
  readonly excludedBackendNodeIds: ReadonlySet<number>;
}

export interface DecodedDocument {
  nodes: DecodedNode[];
}

/** All snapshot nodes participate, including document and shadow roots. This
 * preserves overlay propagation when the semantic adapter omits those nodes. */
export async function buildDocumentIndex<T extends DecodedNode>(
  input: readonly T[],
  signal?: AbortSignal,
): Promise<DocumentIndex<T>> {
  const checkpoint = createCaptureCheckpoint(signal);
  const nodes = new Map<number, T>();
  const overlayByNode = new Map<number, boolean>();
  const excludedBackendNodeIds = new Set<number>();
  for (let i = 0; i < input.length; i++) {
    if (i % 256 === 0) {
      const pending = checkpoint();
      if (pending) await pending;
    }
    const node = input[i];
    nodes.set(node.backendNodeId, node);
  }
  let work = 0;
  for (const node of input) {
    if (work++ % 256 === 0) {
      const pending = checkpoint();
      if (pending) await pending;
    }
    if (overlayByNode.has(node.backendNodeId)) continue;
    const path: DecodedNode[] = [];
    const visiting = new Set<number>();
    let current: DecodedNode | undefined = node;
    let overlay = false;
    while (current && !overlayByNode.has(current.backendNodeId)) {
      if (work++ % 256 === 0) {
        const pending = checkpoint();
        if (pending) await pending;
      }
      if (visiting.has(current.backendNodeId)) {
        // Only an overlay inside the cycle may mark the cycle and its descendants.
        overlay = path
          .slice(path.findIndex((item) => item.backendNodeId === current!.backendNodeId))
          .some((item) => isOverlayHostNode(item.tag, Object.keys(item.attrs)));
        break;
      }
      visiting.add(current.backendNodeId);
      path.push(current);
      if (current.parentBackendNodeId === null) {
        current = undefined;
        break;
      }
      current = nodes.get(current.parentBackendNodeId);
    }
    if (current && overlayByNode.has(current.backendNodeId))
      overlay = overlayByNode.get(current.backendNodeId)!;
    for (let i = path.length - 1; i >= 0; i--) {
      if (work++ % 256 === 0) {
        const pending = checkpoint();
        if (pending) await pending;
      }
      const item = path[i];
      overlay = overlay || isOverlayHostNode(item.tag, Object.keys(item.attrs));
      overlayByNode.set(item.backendNodeId, overlay);
      if (overlay) excludedBackendNodeIds.add(item.backendNodeId);
    }
  }
  return { nodes, excludedBackendNodeIds };
}

export interface DocumentIdentity {
  attachmentId: string;
  target: CdpTarget;
  frameId: string;
  loaderId: string;
  documentElementBackendNodeId: number;
}
