// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CdpFrame, CdpFrameGraph, CdpTarget } from "@/browser-driver/frame-graph";
import type { CdpRunner } from "../shared";
import { captureObservationFacts } from "../vom/capture-coordinator";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type Tree = { frame: { id: string; parentId?: string; name?: string }; childFrames?: Tree[] };
type Rect = { x: number; y: number; w: number; h: number };
type Oracle = { probe: Rect; owners: Record<string, { x: number; y: number; scale: number }> };

// The independent oracle uses DOM border boxes and this fixture's axis-aligned
// iframe transforms. No production snapshot conversion/projection builds expectations.
const oracleExpression = `(() => {
  const box = document.querySelector('#probe').getBoundingClientRect();
  const owners = {};
  for (const frame of document.querySelectorAll('iframe')) {
    const rect = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const scale = rect.width / frame.offsetWidth;
    owners[frame.name] = {
      x: rect.x + (frame.clientLeft + parseFloat(style.paddingLeft)) * scale,
      y: rect.y + (frame.clientTop + parseFloat(style.paddingTop)) * scale,
      scale,
    };
  }
  return { probe: { x: box.x, y: box.y, w: box.width, h: box.height }, owners };
})()`;

describe.skipIf(!process.env.BSK_GEOMETRY_CHROME)("real DOMSnapshot coordinate contract", () => {
  it.each([
    { deviceScale: 1, zoom: 1 },
    { deviceScale: 0.8, zoom: 1 },
    { deviceScale: 1, zoom: 1.25 },
    { deviceScale: 2, zoom: 1 },
    { deviceScale: 2, zoom: 0.8 },
  ])("matches DOM geometry at device scale $deviceScale and zoom $zoom", async (configuration) => {
    const evalRoot = new URL("../../../../../evals/browser/", import.meta.url);
    const { createEvalServer } = await import(new URL("lib/server.mjs", evalRoot).href);
    const { withChrome } = await import(
      new URL("cases/regression/snapshot-coordinates/chrome.mjs", evalRoot).href
    );
    const server = createEvalServer();
    const { baseUrl } = await server.start();
    try {
      await withChrome(
        { executable: process.env.BSK_GEOMETRY_CHROME, ...configuration },
        async (send: Send) => {
          const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
            url: "about:blank",
          });
          const { sessionId: rootSession } = await send<{ sessionId: string }>(
            "Target.attachToTarget",
            { targetId, flatten: true },
          );
          await send(
            "Page.navigate",
            { url: `${baseUrl}/snapshot-coordinates?run=coordinates` },
            rootSession,
          );
          await expect
            .poll(
              () =>
                server
                  .snapshot("coordinates")
                  .events.some(
                    (event: { type: string; data: { root?: boolean } }) =>
                      event.type === "geometry.ready" && event.data.root,
                  ),
              { timeout: 10_000 },
            )
            .toBe(true);

          const targets = await send<{ targetInfos: { targetId: string; type: string }[] }>(
            "Target.getTargets",
          );
          const sessions = [rootSession];
          for (const target of targets.targetInfos.filter((target) => target.type === "iframe")) {
            const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId: target.targetId,
              flatten: true,
            });
            sessions.push(sessionId);
          }
          expect(sessions.length).toBe(2); // The cross-site fixture must actually be an OOPIF.
          const frames: CdpFrame[] = [];
          const names = new Map<string, string>();
          const sessionFor = (target: CdpTarget) => target.sessionId ?? rootSession;
          for (const sessionId of sessions) {
            const { frameTree } = await send<{ frameTree: Tree }>(
              "Page.getFrameTree",
              {},
              sessionId,
            );
            const target: CdpTarget = {
              tabId: 1,
              ...(sessionId === rootSession ? {} : { sessionId }),
            };
            const visit = (tree: Tree, parentFrameId = tree.frame.parentId) => {
              frames.push({ frameId: tree.frame.id, parentFrameId, target });
              names.set(tree.frame.id, tree.frame.name ?? "");
              for (const child of tree.childFrames ?? []) visit(child, tree.frame.id);
            };
            visit(frameTree);
          }
          expect(frames).toHaveLength(5);
          for (const frame of frames) {
            if (!frame.parentFrameId) continue;
            const parent = frames.find((item) => item.frameId === frame.parentFrameId)!;
            const owner = await send<{ backendNodeId: number }>(
              "DOM.getFrameOwner",
              { frameId: frame.frameId },
              sessionFor(parent.target),
            );
            frame.ownerBackendNodeId = owner.backendNodeId;
          }
          const graph: CdpFrameGraph = { rootFrameId: frames[0].frameId, frames };
          const calls: string[] = [];
          const cdp: CdpRunner = {
            send: (tabId, method, params) => {
              calls.push(`${tabId}:${method}`);
              return send(method, params, rootSession);
            },
            sendToTarget: (target, method, params) => {
              calls.push(`${target.sessionId ?? target.tabId}:${method}`);
              return send(method, params, sessionFor(target));
            },
            getFrameGraph: async () => graph,
          };
          const oracles = new Map<string, Oracle>();
          for (const frame of frames) {
            const session = sessionFor(frame.target);
            const { executionContextId } = await send<{ executionContextId: number }>(
              "Page.createIsolatedWorld",
              { frameId: frame.frameId, worldName: "coordinate-oracle" },
              session,
            );
            await expect
              .poll(
                async () => {
                  const ready = await send<{ result: { value: boolean } }>(
                    "Runtime.evaluate",
                    {
                      expression: 'document.documentElement.dataset.geometryReady === "true"',
                      contextId: executionContextId,
                      returnByValue: true,
                    },
                    session,
                  );
                  return ready.result.value;
                },
                { timeout: 5_000 },
              )
              .toBe(true);
            // Establish scroll after cross-process target creation/layout settles.
            const scroll = frame.parentFrameId
              ? names.get(frame.frameId) === "nested"
                ? [10, 20]
                : [40, 100]
              : [80, 240];
            await send(
              "Runtime.evaluate",
              {
                expression: `(async () => { scrollTo(${scroll.join(",")}); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()`,
                contextId: executionContextId,
                awaitPromise: true,
              },
              session,
            );
            const reply = await send<{ result: { value: Oracle } }>(
              "Runtime.evaluate",
              { expression: oracleExpression, contextId: executionContextId, returnByValue: true },
              session,
            );
            oracles.set(frame.frameId, reply.result.value);
          }
          const facts = await captureObservationFacts(cdp, 1);
          expect(facts.issues).toEqual([]);
          for (const frame of frames) {
            const node = facts.documents
              .find((doc) => doc.frame.frameId === frame.frameId)
              ?.domNodes.find((node) => node.attrs.id === "probe");
            expect(node, `missing probe in ${names.get(frame.frameId) || "root"}`).toBeDefined();
            const local = oracles.get(frame.frameId)!.probe;
            const top = { ...local };
            let current = frame;
            while (current.parentFrameId) {
              const owner = oracles.get(current.parentFrameId)!.owners[names.get(current.frameId)!];
              top.x = owner.x + top.x * owner.scale;
              top.y = owner.y + top.y * owner.scale;
              top.w *= owner.scale;
              top.h *= owner.scale;
              current = frames.find((item) => item.frameId === current.parentFrameId)!;
            }
            expect(
              node!.rect,
              JSON.stringify({
                frame: names.get(frame.frameId),
                local,
                top,
                viewport: facts.viewport,
              }),
            ).not.toBeNull();
            for (const key of ["x", "y", "w", "h"] as const) {
              expect(
                Math.abs(node!.localRect![key] - local[key]),
                `${names.get(frame.frameId)} local ${key}`,
              ).toBeLessThan(2);
              expect(
                Math.abs(node!.rect![key] - top[key]),
                `${names.get(frame.frameId)} top ${key}`,
              ).toBeLessThan(2);
            }
          }
          expect(calls.filter((call) => call.endsWith(":Page.getLayoutMetrics"))).toHaveLength(
            sessions.length,
          );
          const metrics = await send<{
            cssVisualViewport: { zoom: number };
            visualViewport: { clientWidth: number };
          }>("Page.getLayoutMetrics", {}, rootSession);
          expect(metrics.cssVisualViewport.zoom).toBeCloseTo(configuration.zoom, 4);
        },
      );
    } finally {
      await server.stop();
    }
  }, 30_000);
});
