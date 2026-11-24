// Проверяем настоящий скрипт панели: доставка, восстановление и повторы событий.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function panel(cameras = []) {
  const elements = new Map(), intervals = new Map(), sockets = [], retries = [];
  let beeps = 0;
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: "", className: "", hidden: true,
      innerHTML: "", src: "", removeAttribute(name) { this[name] = ""; }, lastElementChild: { textContent: "" } });
    return elements.get(id);
  };
  const gain = { gain: { value: 0 }, connect() {} };
  vm.runInNewContext(script, {
    document: { getElementById: element },
    location: { protocol: "http:", host: "localhost:8000" },
    WebSocket: class { constructor(url) { this.url = url; sockets.push(this); } },
    AudioContext: class {
      currentTime = 0;
      createGain() { return gain; }
      createOscillator() { return { frequency: {}, connect: () => gain, start: () => beeps++, stop() {} }; }
    },
    fetch: async (url) => ({ json: async () => ({
      "/api/cameras": cameras, "/api/sensors": { imu: [], actuators: [] },
    })[url] ?? [] }),
    setInterval(fn, delay) { intervals.set(delay, fn); },
    setTimeout(fn, delay) { retries.push({ fn, delay }); },
  });
  return { element, sockets, retries, beeps: () => beeps, poll: () => intervals.get(700)(),
    receive(data) { sockets.at(-1).onmessage({ data: JSON.stringify(data) }); },
    reconnect() { sockets.at(-1).onclose(); retries.at(-1).fn(); sockets.at(-1).onopen(); } };
}

const alert = (id, t = 100) => ({ event_id: id, t, text: `Падение ${id}`, person: "P-001",
  camera_id: "cam_01", zone: "A", confidence: .9, imu_confirmed: true });

test("пустая история не показывает тревогу", () => {
  const p = panel();
  p.receive({ type: "hello", recent: [] });
  assert.equal(p.element("alert").className, "");
});

test("восстанавливается только последняя тревога, без звука и мигания", () => {
  const p = panel();
  p.element("sound").onclick();
  const before = p.beeps();
  p.receive({ type: "hello", recent: [alert("old", 90), alert("last")] });
  assert.equal(p.element("alert-txt").textContent, "Падение last");
  assert.equal(p.element("alert").className, "active");
  assert.match(p.element("alert-k").textContent, /^Последняя тревога/);
  assert.equal(p.beeps(), before);
  assert.equal(p.element("ack").hidden, false);
});

test("после обрыва принятая тревога не появляется повторно, новая приходит", () => {
  const p = panel();
  p.element("sound").onclick();
  p.receive({ type: "alert", alert: alert("first") });
  assert.equal(p.element("alert").className, "active pulse");
  const before = p.beeps();
  p.element("ack").onclick();
  p.reconnect();
  assert.equal(p.retries[0].delay, 1500);
  assert.equal(p.sockets.length, 2);
  assert.equal(p.element("c-ws").className, "chip on");
  p.receive({ type: "hello", recent: [alert("first")] });
  p.receive({ type: "alert", alert: alert("first") });
  assert.equal(p.element("alert").className, "");
  assert.equal(p.element("ack").hidden, true);
  assert.equal(p.beeps(), before);
  p.receive({ type: "alert", alert: alert("second", 101) });
  assert.equal(p.element("alert-txt").textContent, "Падение second");
  assert.equal(p.beeps(), before + 1);
});

test("пропущенная тревога восстанавливается, дубли и старые события её не заменяют", () => {
  const p = panel();
  p.receive({ type: "alert", alert: alert("first") });
  p.reconnect();
  p.receive({ type: "hello", recent: [alert("first"), alert("missed", 110)] });
  assert.equal(p.element("alert-txt").textContent, "Падение missed");
  p.receive({ type: "alert", alert: alert("missed", 110) });
  p.receive({ type: "alert", alert: alert("delayed", 105) });
  assert.equal(p.element("alert-txt").textContent, "Падение missed");
  assert.equal(p.element("alert").className, "active");
});

test("видеопоток запрашивается заново после ошибки камеры", async () => {
  const p = panel([{ id: "cam_01", connected: true, source: "synthetic", fps: 15 }]);
  const stream = p.element("stream"), placeholder = p.element("ph");
  await p.poll();
  assert.equal(stream.src, "/api/cameras/cam_01/stream");
  stream.onerror();
  assert.equal(stream.src, "");
  assert.equal(placeholder.hidden, false);
  await p.poll();
  assert.equal(stream.src, "/api/cameras/cam_01/stream");
  stream.onload();
  assert.equal(placeholder.hidden, true);
});
