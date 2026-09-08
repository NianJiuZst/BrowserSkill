import type { Rect, Viewport } from "@browser-skill/vom";
import type { CdpFrame, CdpTarget } from "@/browser-driver/frame-graph";
import { isOverlayHostNode } from "@/lib/overlay-bridge";
import type { FrameProjectionIssue } from "../geometry/coordinate-types";
import type { FrameOwnedAxNode } from "./frame-document";

export interface CapturedNode {
  backendNodeId: number;
  parentBackendNodeId: number | null;
  frameId?: string;
  /** Owning iframe backend node id; `null` for the top-level document. */
  ownerFrameBackendNodeId?: number | null;
  tag: string;
  attrs: Record<string, string>;
  /** Top-level viewport-relative CSS px, clipped to the owning frame viewport. */
  rect: Rect | null;
  /** Frame-local viewport-relative CSS px before top-level projection. */
  localRect?: Rect | null;
  paintOrder: number;
  position: string;
  pointerEvents: string;
  /**
   * computed `cursor`. `cursor: pointer` is the strongest CDP-free signal
   * that a non-semantic element (a `<div>`/`<span>` with a click handler)
   * is actually an interactive control — used by the adapter to surface
   * custom buttons/checkboxes the AX tree drops as `generic`. Optional like
   * `textContent`: the live parser always sets it, hand-built fixtures may not.
   */
  cursor?: string;
  /**
   * Whether the live DOM snapshot provides a painted, non-hidden box for this
   * node. Semantic resolution uses this only for DOM fallback nodes; AX-backed
   * nodes remain authoritative even when they are outside the viewport.
   */
  rendered?: boolean;
  textContent?: string;
  formState?: "empty" | "filled" | "default";
  formValue?: string;
  formDefaultValue?: string;
  formPlaceholder?: string;
}

export interface CapturedSurfaceProbe {
  triggerBackendNodeId: number;
  triggerPoint?: { x: number; y: number };
  triggerAction: "hover" | "focus" | string;
  subItems: string[];
  confidence?: "high" | "medium" | "low";
}

/** Narrow input shared by the existing semantic scene/hover consumers. */
export interface CapturedSceneInput {
  nodes: CapturedNode[];
  viewport: Viewport;
  rootFrameId?: string;
  excludedBackendNodeIds: ReadonlySet<number>;
}

/** Bounds retain their snapshot document CSS units until normalization. */
export interface SnapshotLayout {
  readonly boundsSpace: "snapshot-document-css";
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

export interface CaptureIssue {
  /** Owner failure or inherited blockage; absent for other geometry failures. */
  projectionIssue?: FrameProjectionIssue;
  target: CdpTarget;
  frameId?: string;
  stage: "dom" | "ax" | "ownership" | "geometry" | "forms";
  reason: "capture-unavailable" | "frame-ownership-unresolved" | "geometry-unavailable";
}

export interface DocumentFacts<T extends FrameOwnedAxNode> {
  readonly frame: CdpFrame;
  readonly index: DocumentIndex;
  readonly domNodes: CapturedNode[];
  readonly axNodes: T[];
}

export interface ObservationFacts<T extends FrameOwnedAxNode> {
  readonly rootFrameId: string;
  readonly viewport: Viewport;
  readonly documents: readonly DocumentFacts<T>[];
  readonly issues: readonly CaptureIssue[];
  readonly startedAt: number;
  readonly finishedAt: number;
}

export function throwCaptureAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("observation aborted", "AbortError");
}

export function isCaptureAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Called only at bounded block boundaries, not once per node. */
export async function captureCheckpoint(signal?: AbortSignal): Promise<void> {
  throwCaptureAborted(signal);
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
  throwCaptureAborted(signal);
}

/** All snapshot nodes participate, including document and shadow roots. This
 * preserves overlay propagation when the semantic adapter omits those nodes. */
export async function buildDocumentIndex<T extends DecodedNode>(
  input: readonly T[],
  signal?: AbortSignal,
): Promise<DocumentIndex<T>> {
  const nodes = new Map<number, T>();
  const overlayByNode = new Map<number, boolean>();
  const excludedBackendNodeIds = new Set<number>();
  for (let i = 0; i < input.length; i++) {
    if (i % 256 === 0) await captureCheckpoint(signal);
    const node = input[i];
    nodes.set(node.backendNodeId, node);
  }
  let work = 0;
  for (const node of input) {
    if (work++ % 256 === 0) await captureCheckpoint(signal);
    if (overlayByNode.has(node.backendNodeId)) continue;
    const path: DecodedNode[] = [];
    const visiting = new Set<number>();
    let current: DecodedNode | undefined = node;
    let overlay = false;
    while (current && !overlayByNode.has(current.backendNodeId)) {
      if (work++ % 256 === 0) await captureCheckpoint(signal);
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
      if (work++ % 256 === 0) await captureCheckpoint(signal);
      const item = path[i];
      overlay = overlay || isOverlayHostNode(item.tag, Object.keys(item.attrs));
      overlayByNode.set(item.backendNodeId, overlay);
      if (overlay) excludedBackendNodeIds.add(item.backendNodeId);
    }
  }
  return { nodes, excludedBackendNodeIds };
}
