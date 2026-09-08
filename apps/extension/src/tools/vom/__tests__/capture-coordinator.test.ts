import { describe, expect, it, vi } from "vitest";
import type { CdpFrame, CdpTarget } from "@/browser-driver/frame-graph";
import { cdpTargetKey } from "@/browser-driver/frame-graph";
import { OVERLAY_HOST_MARKER_ATTR } from "@/lib/overlay-bridge";
import type { CdpRunner } from "../../shared";
import { captureObservationFacts, semanticCapture } from "../capture-coordinator";
import { buildSemanticGraph } from "../semantic-graph/build";
import { REQUESTED_STYLES } from "../snapshot";

function fixture(
  options: { frames?: CdpFrame[]; fail?: string; omitDocument?: string; overlay?: string } = {},
) {
  const frames = options.frames ?? [
    { frameId: "main", target: { tabId: 4 } },
    {
      frameId: "same",
      parentFrameId: "main",
      ownerBackendNodeId: 3,
      target: { tabId: 4 },
    },
    {
      frameId: "nested",
      parentFrameId: "same",
      ownerBackendNodeId: 13,
      target: { tabId: 4 },
    },
    {
      frameId: "remote",
      parentFrameId: "main",
      ownerBackendNodeId: 4,
      target: { tabId: 4, sessionId: "remote" },
    },
  ];
  const elements = new Map(
    frames.map((frame, i) => [frame.frameId, frame.target.sessionId ? 1 : i * 10 + 1]),
  );
  const logs: Array<{ target: CdpTarget; method: string; params: Record<string, unknown> }> = [];
  const send = vi.fn(
    async <T>(target: CdpTarget, method: string, params: object = {}): Promise<T> => {
      logs.push({ target, method, params: params as Record<string, unknown> });
      const args = params as Record<string, string | number>;
      if (options.fail === `${target.sessionId ?? "main"}:${method}`)
        throw new Error("fixture failure");
      let result: unknown = {};
      if (method === "Page.getLayoutMetrics")
        result = { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } };
      if (method === "DOMSnapshot.captureSnapshot") {
        expect((params as { computedStyles: unknown }).computedStyles).toEqual(REQUESTED_STYLES);
        result = {
          strings: [
            "#document",
            "html",
            "button",
            OVERLAY_HOST_MARKER_ATTR,
            "",
            "visible",
            "1",
            "static",
            "auto",
          ],
          documents: frames
            .filter(
              (frame) =>
                cdpTargetKey(frame.target) === cdpTargetKey(target) &&
                frame.frameId !== options.omitDocument,
            )
            .map((frame) => {
              const element = elements.get(frame.frameId)!;
              return {
                frameId: frame.frameId,
                nodes: {
                  backendNodeId: [element - 1, element + 10000, element, element + 1],
                  nodeName: [0, 1, 1, 2],
                  nodeType: [9, 10, 1, 1],
                  parentIndex: [-1, 0, 0, 2],
                  attributes: [[], [], [], frame.frameId === options.overlay ? [3, 4] : []],
                },
                layout: {
                  nodeIndex: [2, 3],
                  bounds: [
                    [0, 0, 1000, 800],
                    [10, 20, 100, 40],
                  ],
                  styles: [
                    [7, 8, 8, 5, 6],
                    [7, 8, 8, 5, 6],
                  ],
                },
              };
            }),
        };
      }
      if (method === "Accessibility.getFullAXTree") {
        const frameId = String(args.frameId);
        result = {
          nodes: [
            {
              nodeId: `${frameId}-button`,
              frameId,
              backendDOMNodeId: elements.get(frameId)! + 1,
              role: { value: "button" },
              name: { value: frameId },
            },
          ],
        };
      }
      return result as T;
    },
  );
  const cdp: CdpRunner = {
    getFrameGraph: async () => ({ rootFrameId: frames[0].frameId, frames }),
    send: (tabId, method, params) =>
      (send as NonNullable<CdpRunner["sendToTarget"]>)({ tabId }, method, params),
    sendToTarget: send as NonNullable<CdpRunner["sendToTarget"]>,
  };
  return { cdp, logs, elements };
}

describe("captureObservationFacts", () => {
  it("collects each target once and scopes equal backend IDs", async () => {
    const { cdp, logs } = fixture();
    const facts = await captureObservationFacts(cdp, 4);
    expect(logs.filter((call) => call.method === "DOMSnapshot.captureSnapshot")).toHaveLength(2);
    expect(logs.filter((call) => call.method === "Accessibility.enable")).toHaveLength(2);
    expect(logs.filter((call) => call.method === "Accessibility.getFullAXTree")).toHaveLength(4);
    const main = facts.documents.find((doc) => doc.frame.frameId === "main")!;
    const remote = facts.documents.find((doc) => doc.frame.frameId === "remote")!;
    expect(main.index.nodes.get(2)).not.toBe(remote.index.nodes.get(2));
    expect(main.index.nodes.get(2)?.parentBackendNodeId).toBe(1);
    expect(main.index.nodes.get(10001)?.nodeType).toBe(10);
    expect(remote.axNodes[0].frameId).toBe("remote");
    expect(main.index.nodes.get(2)).toBe(main.domNodes.find((node) => node.backendNodeId === 2));
    expect(facts.finishedAt).toBeGreaterThanOrEqual(facts.startedAt);
  });

  it("does not retry failed or missing documents and retains valid AX-only semantics", async () => {
    const { cdp, logs } = fixture({
      fail: "remote:DOMSnapshot.captureSnapshot",
      omitDocument: "same",
    });
    const facts = await captureObservationFacts(cdp, 4);
    const remote = facts.documents.find((doc) => doc.frame.frameId === "remote")!;
    expect(remote.domNodes).toHaveLength(0);
    expect(remote.axNodes).toHaveLength(1);
    expect(logs.filter((call) => call.method === "DOMSnapshot.captureSnapshot")).toHaveLength(2);
    expect(facts.issues).toContainEqual(
      expect.objectContaining({ frameId: "same", stage: "dom", reason: "capture-unavailable" }),
    );
    expect(facts.issues).toContainEqual(
      expect.objectContaining({ target: { tabId: 4, sessionId: "remote" }, stage: "dom" }),
    );
  });

  it("excludes overlay AX in its own document without excluding equal IDs elsewhere", async () => {
    const facts = await captureObservationFacts(fixture({ overlay: "remote" }).cdp, 4);
    const { documents } = semanticCapture(facts);
    const graph = buildSemanticGraph({
      documents,
      viewport: facts.viewport,
      rootFrameId: facts.rootFrameId,
    });
    expect(
      [...graph.nodes.values()].find(
        (node) => node.frameId === "remote" && node.backendNodeId === 2,
      )?.excluded,
    ).toBe(true);
    expect(
      [...graph.nodes.values()].find((node) => node.frameId === "main" && node.backendNodeId === 2)
        ?.excluded,
    ).toBe(false);
  });

  it.each([
    "cancel",
    "worker-abort",
  ] as const)("joins target cleanup and stops claiming targets after %s", async (mode) => {
    const frames = Array.from({ length: 5 }, (_, i) => ({
      frameId: `f${i}`,
      target: { tabId: 4, ...(i ? { sessionId: `s${i}` } : {}) },
    }));
    const { cdp } = fixture({ frames });
    const original = cdp.sendToTarget!;
    const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
    const calls: Array<{ target: string; method: string }> = [];
    let release: (() => void) | undefined;
    let released = false;
    const send: NonNullable<CdpRunner["sendToTarget"]> = async <T>(
      target: CdpTarget,
      method: string,
      params?: object,
    ) => {
      calls.push({ target: target.sessionId ?? "main", method });
      if (method === "DOMSnapshot.captureSnapshot" && target.sessionId) {
        await new Promise<void>((resolve, reject) =>
          pending.set(target.sessionId!, { resolve, reject }),
        );
      }
      if (method === "Runtime.releaseObjectGroup") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        released = true;
      }
      const result = await original<T>(target, method, params);
      if (method === "DOMSnapshot.captureSnapshot" && !target.sessionId)
        (result as { strings: string[] }).strings[2] = "input";
      return result;
    };
    cdp.sendToTarget = send;
    cdp.send = (tabId, method, params) => send({ tabId }, method, params);
    const controller = new AbortController();
    let settled = false;
    const capture = captureObservationFacts(cdp, 4, controller.signal);
    const rejected = expect(capture).rejects.toMatchObject({ name: "AbortError" });
    void capture.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => {
      expect(pending.size).toBe(3);
      expect(release).toBeDefined();
    });
    if (mode === "cancel") controller.abort();
    // Cancellation may race with an ordinary transport rejection. Without an
    // external signal, an escaping AbortError still terminates the worker pool.
    pending
      .get("s1")!
      .reject(
        mode === "cancel"
          ? new Error("transport closed")
          : new DOMException("target aborted", "AbortError"),
      );
    pending.get("s2")!.resolve();
    pending.get("s3")!.resolve();
    await vi.waitFor(() => {
      if (mode === "worker-abort")
        expect(
          calls.some(
            (call) => call.target === "s3" && call.method === "Accessibility.getFullAXTree",
          ),
        ).toBe(true);
      else
        expect(
          calls.some(
            (call) => call.target === "s3" && call.method === "DOMSnapshot.captureSnapshot",
          ),
        ).toBe(true);
    });
    // Allow worker rejection and the outer promise chain to run while cleanup
    // is deliberately held. The old fail-fast pool settles here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(released).toBe(false);
    expect(calls.some((call) => call.target === "s4")).toBe(false);
    if (mode === "cancel")
      expect(
        calls.some(
          (call) => call.method === "Accessibility.enable" || call.method === "DOM.getDocument",
        ),
      ).toBe(false);
    release!();
    await rejected;
    expect(released).toBe(true);
    expect(calls.some((call) => call.target === "s4")).toBe(false);
  });

  it("bounds collection across many targets and stops scheduling after cancellation", async () => {
    const frames = Array.from({ length: 12 }, (_, i) => ({
      frameId: `f${i}`,
      target: { tabId: 4, ...(i ? { sessionId: `s${i}` } : {}) },
    }));
    const { cdp } = fixture({ frames });
    let active = 0,
      peak = 0;
    const original = cdp.sendToTarget!;
    const send: NonNullable<CdpRunner["sendToTarget"]> = async (target, method, params) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await original(target, method, params);
      } finally {
        active--;
      }
    };
    cdp.sendToTarget = send;
    cdp.send = (tabId, method, params) => send({ tabId }, method, params);
    await captureObservationFacts(cdp, 4);
    // This fixture has no frame edges, so no concurrent owner requests.
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    const controller = new AbortController();
    controller.abort();
    await expect(captureObservationFacts(cdp, 4, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(active).toBe(0);
  });
});

function childSnapshot(frameId: string, backendNodeId: number) {
  const strings = [frameId, "body", "button", "static", "auto", "pointer"];
  return {
    strings,
    documents: [
      {
        frameId,
        nodes: {
          parentIndex: [-1, 0],
          nodeName: [1, 2],
          backendNodeId: [backendNodeId - 1, backendNodeId],
          attributes: [[], []],
        },
        layout: {
          nodeIndex: [0, 1],
          styles: [
            [3, 4, 4],
            [3, 4, 5],
          ],
          bounds: [
            [0, 0, 300, 200],
            [10, 20, 100, 40],
          ],
          paintOrders: [0, 1],
        },
      },
    ],
  };
}

describe("OOPIF capture", () => {
  it("captures and positions multiple OOPIF documents missing from the root snapshot", async () => {
    const sendToTarget = vi.fn(async (target, method) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 300, clientHeight: 200, pageX: 0, pageY: 0 } };
      }
      if (method === "DOMSnapshot.enable" || method === "Accessibility.enable") return {};
      if (method === "DOMSnapshot.captureSnapshot") {
        return target.sessionId === "left-session"
          ? childSnapshot("left", 101)
          : childSnapshot("right", 201);
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      throw new Error(`unexpected ${method}`);
    });
    const cdp: CdpRunner = {
      send: vi.fn(async (_tabId, method, params) => {
        if (method === "Accessibility.enable" || method === "DOMSnapshot.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return childSnapshot("main", 1);
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        if (method === "DOM.getBoxModel") {
          const backendNodeId = (params as { backendNodeId?: number })?.backendNodeId;
          const x = backendNodeId === 10 ? 50 : 500;
          return { model: { content: [x, 100, x + 300, 100, x + 300, 300, x, 300] } };
        }
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } };
        }
        throw new Error(`unexpected root ${method}`);
      }) as CdpRunner["send"],
      sendToTarget: sendToTarget as unknown as NonNullable<CdpRunner["sendToTarget"]>,
      getFrameGraph: vi.fn(async () => ({
        rootFrameId: "main",
        frames: [
          { frameId: "main", target: { tabId: 4 } },
          {
            frameId: "left",
            parentFrameId: "main",
            ownerBackendNodeId: 10,
            target: { tabId: 4, sessionId: "left-session" },
          },
          {
            frameId: "right",
            parentFrameId: "main",
            ownerBackendNodeId: 20,
            target: { tabId: 4, sessionId: "right-session" },
          },
        ],
      })),
    };

    const { documents: trees } = semanticCapture(await captureObservationFacts(cdp, 4));

    expect(trees.map((tree) => tree.frameId)).toEqual(["main", "left", "right"]);
    expect(
      trees
        .find((doc) => doc.frameId === "left")
        ?.domNodes?.find((node) => node.backendNodeId === 101)?.rect,
    ).toEqual({ x: 60, y: 120, w: 100, h: 40 });
    expect(
      trees
        .find((doc) => doc.frameId === "right")
        ?.domNodes?.find((node) => node.backendNodeId === 201)?.rect,
    ).toEqual({ x: 510, y: 120, w: 100, h: 40 });
    expect(
      new Map(
        trees
          .filter((doc) => doc.ownerBackendNodeId !== undefined)
          .map((doc) => [doc.frameId, doc.ownerBackendNodeId]),
      ),
    ).toEqual(
      new Map([
        ["left", 10],
        ["right", 20],
      ]),
    );
    expect(
      new Map(
        trees.filter((doc) => doc.parentFrameId).map((doc) => [doc.frameId, doc.parentFrameId]),
      ),
    ).toEqual(
      new Map([
        ["left", "main"],
        ["right", "main"],
      ]),
    );
  });

  it("retains nested owner failures when merging a captured OOPIF", async () => {
    const child = childSnapshot("child", 101);
    const nested = childSnapshot("nested", 201);
    const document = child.documents[0];
    const snapshot = {
      strings: child.strings,
      documents: [
        {
          ...document,
          nodes: { ...document.nodes, contentDocumentIndex: { index: [1], value: [1] } },
        },
        nested.documents[0],
      ],
    };
    const reply = async (_target: unknown, method: string) => {
      if (method === "Page.getLayoutMetrics")
        return { cssLayoutViewport: { clientWidth: 300, clientHeight: 200 } };
      if (method === "DOMSnapshot.captureSnapshot") return snapshot;
      if (method === "DOM.getBoxModel")
        return { model: { content: [50, 100, 350, 100, 350, 300, 50, 300] } };
      if (method === "DOM.resolveNode") throw new Error("nested owner replaced");
      return {};
    };
    const cdp: CdpRunner = {
      send: vi.fn(reply) as CdpRunner["send"],
      sendToTarget: vi.fn(reply) as NonNullable<CdpRunner["sendToTarget"]>,
      getFrameGraph: vi.fn(async () => ({
        rootFrameId: "main",
        frames: [
          { frameId: "main", target: { tabId: 4 } },
          {
            frameId: "nested",
            parentFrameId: "child",
            ownerBackendNodeId: 101,
            target: { tabId: 4, sessionId: "child-session" },
          },
          {
            frameId: "child",
            parentFrameId: "main",
            ownerBackendNodeId: 10,
            target: { tabId: 4, sessionId: "child-session" },
          },
        ],
      })),
    };
    const captured = await captureObservationFacts(cdp, 4);
    expect(
      captured.issues
        .filter((issue) => issue.projectionIssue)
        .map((issue) => issue.projectionIssue),
    ).toEqual([
      {
        status: "unavailable",
        source: { target: { tabId: 4, sessionId: "child-session" }, frameId: "nested" },
        ownerBackendNodeId: 101,
      },
    ]);
    expect(
      captured.documents.find((doc) => doc.frame.frameId === "nested")?.domNodes[1],
    ).toMatchObject({
      rect: null,
      localRect: { x: 10, y: 20, w: 100, h: 40 },
    });
  });

  it("keeps OOPIF semantics when viewport projection is unavailable", async () => {
    const cdp: CdpRunner = {
      send: vi.fn(async (_tabId, method) => {
        if (method === "Accessibility.enable" || method === "DOMSnapshot.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return childSnapshot("main", 1);
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        if (method === "DOM.getBoxModel") throw new Error("owner geometry unavailable");
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } };
        }
        throw new Error(`unexpected root ${method}`);
      }) as CdpRunner["send"],
      sendToTarget: vi.fn(async (_target, method) => {
        if (method === "Page.getLayoutMetrics") throw new Error("viewport unavailable");
        if (method === "DOMSnapshot.enable" || method === "Accessibility.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return childSnapshot("child", 101);
        if (method === "Accessibility.getFullAXTree") {
          return {
            nodes: [
              {
                nodeId: "button",
                backendDOMNodeId: 101,
                role: { type: "role", value: "button" },
                name: { type: "computedString", value: "Continue" },
              },
            ],
          };
        }
        throw new Error(`unexpected ${method}`);
      }) as unknown as NonNullable<CdpRunner["sendToTarget"]>,
      getFrameGraph: vi.fn(async () => ({
        rootFrameId: "main",
        frames: [
          { frameId: "main", target: { tabId: 4 } },
          {
            frameId: "child",
            parentFrameId: "main",
            ownerBackendNodeId: 10,
            target: { tabId: 4, sessionId: "child-session" },
          },
        ],
      })),
    };

    const { documents } = semanticCapture(await captureObservationFacts(cdp, 4));
    const childDocument = documents.find((document) => document.frameId === "child");

    expect(childDocument?.axNodes).toEqual([
      expect.objectContaining({ backendDOMNodeId: 101, frameId: "child" }),
    ]);
    expect(childDocument?.domNodes.find((node) => node.backendNodeId === 101)).toEqual(
      expect.objectContaining({ rect: null, localRect: { x: 10, y: 20, w: 100, h: 40 } }),
    );
  });
});

// Six sibling frames and one nested frame exercise scheduling through the real capture entry.
function siblingCaptureFixture(
  beforeReply: (method: string, params: Record<string, unknown>) => Promise<void> = async () => {},
) {
  const document = (id: number, owners: number[], childIndexes: number[]) => ({
    frameId: `frame-${id}`,
    nodes: {
      parentIndex: [-1, ...owners.map(() => 0)],
      nodeName: [0, ...owners.map(() => 1)],
      backendNodeId: [1000 + id, ...owners],
      attributes: [[], ...owners.map(() => [])],
      contentDocumentIndex: { index: owners.map((_, i) => i + 1), value: childIndexes },
    },
    layout: {
      nodeIndex: [0, ...owners.map((_, i) => i + 1)],
      bounds: [[0, 0, 200, 100], ...owners.map(() => [0, 0, 200, 100])],
    },
  });
  const snapshot = {
    strings: ["body", "iframe"],
    documents: [
      document(0, [100, 101, 102, 103, 104, 105], [1, 2, 3, 4, 5, 6]),
      document(1, [200], [7]),
      ...Array.from({ length: 6 }, (_, i) => document(i + 2, [], [])),
    ],
  };
  let active = 0;
  let peak = 0;
  const send = vi.fn(async (_tabId: number, method: string, params: object = {}) => {
    const args = params as Record<string, unknown>;
    active++;
    peak = Math.max(peak, active);
    try {
      await beforeReply(method, args);
      if (method === "DOMSnapshot.captureSnapshot") return snapshot;
      if (method === "Page.getLayoutMetrics")
        return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } };
      if (method === "DOM.getBoxModel")
        return { model: { content: [0, 0, 200, 0, 200, 100, 0, 100] } };
      if (method === "DOM.resolveNode") return { object: { objectId: String(args.backendNodeId) } };
      if (method === "Runtime.callFunctionOn")
        return { result: { value: { width: 200, height: 100 } } };
      return {};
    } finally {
      active--;
    }
  });
  return {
    cdp: { send: send as CdpRunner["send"] },
    send,
    peak: () => peak,
    active: () => active,
    measured: () =>
      send.mock.calls
        .filter(([, method]) => method === "DOM.getBoxModel")
        .map(([, , params]) => (params as { backendNodeId: number }).backendNodeId),
  };
}

describe("sibling frame measurement scheduling", () => {
  it("bounds concurrent reads, fills free slots and preserves breadth-first output despite reordered replies", async () => {
    const pending = new Map<number, () => void>();
    const fixture = siblingCaptureFixture(async (method, params) => {
      if (method === "DOM.getBoxModel" && Number(params.backendNodeId) < 200)
        await new Promise<void>((resolve) => pending.set(Number(params.backendNodeId), resolve));
    });
    const capture = captureObservationFacts(fixture.cdp, 4);
    await vi.waitFor(() => expect(pending.size).toBe(4));
    expect(fixture.measured()).toEqual([100, 101, 102, 103]);
    pending.get(103)!();
    await vi.waitFor(() => expect(pending.has(104)).toBe(true));
    pending.get(104)!();
    await vi.waitFor(() => expect(pending.has(105)).toBe(true));
    expect(fixture.measured()).not.toContain(200);
    for (const id of [105, 102, 101, 100]) pending.get(id)!();
    const captured = await capture;
    expect(
      captured.issues
        .filter((issue) => issue.stage === "geometry")
        .map((issue) => issue.projectionIssue),
    ).toEqual([]);
    expect(fixture.peak()).toBe(4);
    expect(fixture.active()).toBe(0);
    expect(fixture.measured()).toEqual([100, 101, 102, 103, 104, 105, 200]);
    expect(captured.documents.map((doc) => doc.frame.frameId)).toEqual(
      Array.from({ length: 8 }, (_, i) => `frame-${i}`),
    );
    expect(
      captured.documents.find((doc) => doc.frame.frameId === "frame-7")?.domNodes[0].rect,
    ).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    for (const method of [
      "DOM.getBoxModel",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
      "Runtime.releaseObject",
    ])
      expect(fixture.send.mock.calls.filter(([, name]) => name === method)).toHaveLength(7);
  });

  it("does not measure descendants of a failed owner and retains sibling geometry and local nodes", async () => {
    const fixture = siblingCaptureFixture(async (method, params) => {
      if (method === "DOM.resolveNode" && params.backendNodeId === 100)
        throw new Error("owner replaced");
    });
    const captured = await captureObservationFacts(fixture.cdp, 4);
    expect(
      captured.issues
        .filter((issue) => issue.stage === "geometry")
        .map((issue) => issue.projectionIssue),
    ).toEqual([
      {
        status: "unavailable",
        source: { target: { tabId: 4 }, frameId: "frame-1" },
        ownerBackendNodeId: 100,
      },
      {
        status: "blocked",
        source: { target: { tabId: 4 }, frameId: "frame-7" },
        cause: captured.issues.find((issue) => issue.frameId === "frame-1")?.projectionIssue,
      },
    ]);
    expect(fixture.measured()).not.toContain(200);
    expect(
      captured.documents.find((doc) => doc.frame.frameId === "frame-7")?.domNodes[0],
    ).toMatchObject({
      tag: "body",
      rect: null,
      localRect: { x: 0, y: 0, w: 200, h: 100 },
    });
    expect(
      captured.documents.find((doc) => doc.frame.frameId === "frame-2")?.domNodes[0].rect,
    ).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    expect(captured.documents.map((doc) => doc.frame.frameId)).toEqual(
      Array.from({ length: 8 }, (_, i) => `frame-${i}`),
    );
  });

  it("stops scheduling on cancellation and waits for resolved objects to be released", async () => {
    const controller = new AbortController();
    const resolutions = new Map<string, () => void>();
    const releases = new Map<string, () => void>();
    const fixture = siblingCaptureFixture(async (method, params) => {
      if (method === "DOM.resolveNode")
        await new Promise<void>((resolve) =>
          resolutions.set(String(params.backendNodeId), resolve),
        );
      if (method === "Runtime.releaseObject")
        await new Promise<void>((resolve) => releases.set(String(params.objectId), resolve));
    });
    let settled = false;
    const capture = captureObservationFacts(fixture.cdp, 4, controller.signal);
    const rejected = expect(capture).rejects.toMatchObject({ name: "AbortError" });
    void capture.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(resolutions.size).toBe(4));
    controller.abort();
    for (const resolve of resolutions.values()) resolve();
    await vi.waitFor(() => expect(releases.size).toBe(4));
    expect(settled).toBe(false);
    expect(fixture.measured()).toEqual([100, 101, 102, 103]);
    for (const release of releases.values()) release();
    await rejected;
    expect(fixture.active()).toBe(0);
    expect(fixture.send.mock.calls.some(([, method]) => method === "Runtime.callFunctionOn")).toBe(
      false,
    );
  });
});
