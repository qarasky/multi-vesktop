import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build, buildSync } from "esbuild";

function evaluate(code, globals = {}) {
    const context = { module: { exports: {} }, ...globals };
    runInNewContext(code, context);
    return context.module.exports;
}
const geometry = evaluate(
    buildSync({ entryPoints: ["src/shared/topgg.ts"], bundle: true, write: false, platform: "node", format: "cjs" })
        .outputFiles[0].text
);

test("the initial button position clears the message composer", () => {
    const point = geometry.getTopggButtonCoordinates(undefined, { width: 800, height: 600 });
    assert.equal(point.x, 738);
    assert.equal(point.y, 458);
});

test("saved relative positions remain visible when the window shrinks", () => {
    const point = geometry.getTopggButtonCoordinates({ x: 0.5, y: 0.5 }, { width: 400, height: 300 });
    assert.equal(point.x, 177);
    assert.equal(point.y, 127);
    const edge = geometry.getTopggButtonCoordinates({ x: 1, y: 1 }, { width: 400, height: 300 });
    assert.equal(edge.x, 346);
    assert.equal(edge.y, 246);
});

test("dragging past edges clamps the saved position into the available area", () => {
    const position = geometry.normalizeTopggButtonPosition({ x: -100, y: 2000 }, { width: 800, height: 600 });
    assert.equal(position.x, 0);
    assert.equal(position.y, 1);
});

test("tiny windows do not create infinite or NaN saved coordinates", () => {
    const position = geometry.normalizeTopggButtonPosition({ x: 20, y: 20 }, { width: 60, height: 50 });
    assert.equal(position.x, 0);
    assert.equal(position.y, 0);
});

test("malformed saved positions fall back safely", () => {
    for (const position of [null, {}, { x: NaN, y: 0 }, { x: Infinity, y: 0 }, { x: -1, y: 0 }, { x: 0, y: "1" }]) {
        assert.equal(geometry.isTopggButtonPosition(position), false);
        assert.equal(geometry.getTopggButtonCoordinates(position, { width: 800, height: 600 }).x, 738);
    }
});

test("position changes persist in shared state and broadcast without replacing account data", async t => {
    const root = mkdtempSync(join(tmpdir(), "multi-vesktop-position-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, "state.json");
    const { SettingsStore } = evaluate(
        buildSync({
            entryPoints: ["src/shared/utils/SettingsStore.ts"],
            bundle: true,
            write: false,
            platform: "node",
            format: "cjs"
        }).outputFiles[0].text
    );
    const state = new SettingsStore({ accounts: [{ id: "existing" }], lastActiveAccountId: "existing" });
    state.addGlobalChangeListener(value => writeFileSync(file, JSON.stringify(value)));
    const events = [];
    const source = (
        await build({
            entryPoints: ["src/main/topggButtonPosition.ts"],
            bundle: true,
            write: false,
            platform: "node",
            format: "cjs",
            external: ["electron"],
            plugins: [
                {
                    name: "test-state",
                    setup(builder) {
                        builder.onResolve({ filter: /^\.\/settings$/ }, () => ({ path: "state", namespace: "test" }));
                        builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
                            contents: "export const State = globalThis.testState;"
                        }));
                    }
                }
            ]
        })
    ).outputFiles[0].text;
    const api = evaluate(source, {
        testState: state,
        require: () => ({
            webContents: {
                getAllWebContents: () => [
                    { isDestroyed: () => false, send: (event, value) => events.push({ event, value }) },
                    { isDestroyed: () => true, send: () => assert.fail("Do not send to destroyed views") }
                ]
            }
        })
    });
    api.setTopggButtonPosition({ x: 0.3, y: 0.4 });
    const stored = JSON.parse(readFileSync(file));
    assert.deepEqual(stored.topggButtonPosition, { x: 0.3, y: 0.4 });
    assert.deepEqual(stored.accounts, [{ id: "existing" }]);
    assert.equal(stored.lastActiveAccountId, "existing");
    assert.equal(api.getTopggButtonPosition().x, 0.3);
    assert.equal(events[0].event, "MV_TOPGG_BUTTON_POSITION_CHANGED");
    assert.equal(events[0].value.y, 0.4);
    assert.throws(() => api.setTopggButtonPosition({ x: NaN, y: 0 }));
    assert.deepEqual(JSON.parse(readFileSync(file)).topggButtonPosition, { x: 0.3, y: 0.4 });
});
