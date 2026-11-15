"""API и WebSocket поверх конвейера: событие из синтетического прогона видно в журнале и прилетает в WS."""
import asyncio
import json

from fastapi.testclient import TestClient

from src.api.app import Context, create_app
from src.bus import InMemoryBus
from src.iot.receiver import ImuReceiver
from src.iot.simulator import samples
from src.pipeline import Pipeline
from src.storage import Store
from src.vision.synthetic import demo_scene

T0 = 1_800_000_000.0


def make():
    bus = InMemoryBus()
    imu = ImuReceiver(bus, clock=lambda: T0 + 13)
    store = Store("sqlite:///:memory:")
    pipe = Pipeline(bus=bus, store=store, imu=imu, devices={"imu_001": "cam_01"})
    ctx = Context(pipe, store, imu, bus)
    return bus, pipe, ctx


def test_rest_endpoints_after_fall():
    bus, pipe, ctx = make()
    for s in samples("imu_001", t0=T0, duration=14, fall_at=6.3):
        bus.publish("cps/imu/imu_001/telemetry", s.model_dump())
    bus.publish("cps/actuators/esp32_01/status", {"raw": "online"})
    for obs in demo_scene(t0=T0).frames(14):
        pipe.on_observation(obs)
    with TestClient(create_app(ctx)) as c:
        assert c.get("/api/health").json()["ok"]
        events = c.get("/api/events").json()
        assert len(events) == 1 and events[0]["imu_confirmed"] is True
        assert c.get(f"/api/events/{events[0]['id']}").json()["person"] == "P-001"
        assert c.get("/api/events/nope").status_code == 404
        people = {p["person"]: p for p in c.get("/api/people").json()}
        assert people["P-001"]["action"] == "lie" and people["P-002"]["action"] in ("walk", "stand")
        sensors = c.get("/api/sensors").json()
        assert sensors["imu"][0]["device_id"] == "imu_001"
        assert sensors["actuators"][0]["online"] is True
        assert "chronopose" in c.get("/").text


def test_websocket_receives_live_alert():
    bus, pipe, ctx = make()
    with TestClient(create_app(ctx)) as c, c.websocket_connect("/ws/events") as ws:
        assert ws.receive_json()["type"] == "hello"
        for obs in demo_scene(t0=T0).frames(12):
            pipe.on_observation(obs)
        msg = ws.receive_json()
        assert msg["type"] == "alert" and msg["alert"]["person"] == "P-001"


def test_websocket_reconnect_restores_alert_missed_while_offline():
    _, pipe, ctx = make()
    with TestClient(create_app(ctx)) as c:
        with c.websocket_connect("/ws/events") as ws:
            assert ws.receive_json() == {"type": "hello", "recent": []}
        for obs in demo_scene(t0=T0).frames(12):
            pipe.on_observation(obs)
        for _ in range(2):
            with c.websocket_connect("/ws/events") as ws:
                hello = ws.receive_json()
                assert hello["type"] == "hello"
                assert [a["event_id"] for a in hello["recent"]] == [pipe.alerts[0].event_id]


def test_websocket_disconnect_releases_subscription_without_another_alert():
    async def run():
        _, _, ctx = make()
        incoming, outgoing = asyncio.Queue(), asyncio.Queue()
        await incoming.put({"type": "websocket.connect"})
        scope = {"type": "websocket", "path": "/ws/events", "headers": [], "query_string": b"", "scheme": "ws"}
        task = asyncio.create_task(create_app(ctx)(scope, incoming.get, outgoing.put))
        try:
            assert (await asyncio.wait_for(outgoing.get(), 1))["type"] == "websocket.accept"
            hello = await asyncio.wait_for(outgoing.get(), 1)
            assert json.loads(hello["text"])["type"] == "hello"
            assert len(ctx.hub.queues) == 1
            await incoming.put({"type": "websocket.disconnect", "code": 1000})
            await asyncio.wait_for(task, 1)
            assert not ctx.hub.queues
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(run())
