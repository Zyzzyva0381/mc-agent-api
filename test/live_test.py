#!/usr/bin/env python3
"""真机验收：RCON 布置环境，HTTP 驱动 bot，逐项断言。

需要一台**专门用来测试**的服务器（脚本会 fill 方块、kill 实体、改难度/天气/时间，
并在 (−4..60, 94..110, −4..62) 一带搭台子）——不要对正式存档跑。

环境变量：
    MC_AGENT_API       API 地址，默认 http://127.0.0.1:18900/api/v1
    MC_AGENT_USER      登录用户名（也是 bot 的角色名），默认 Agent_1
    MC_AGENT_PASSWORD  登录密码（offline 适配器的共享口令 / 外置登录密码）
    RCON_HOST / RCON_PORT / RCON_PASSWORD   测试服 RCON（server.properties 里 enable-rcon=true）

用法：
    python3 test/live_test.py all
    python3 test/live_test.py effects posture boat ...

所有动作都在 y=100 的人工石台上跑，避免自然地形干扰。
"""

import json
import os
import socket
import struct
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
API = os.environ.get("MC_AGENT_API", "http://127.0.0.1:18900/api/v1")
RCON_HOST = os.environ.get("RCON_HOST", "127.0.0.1")
RCON_PORT = int(os.environ.get("RCON_PORT", "25575"))
USER = os.environ.get("MC_AGENT_USER", "Agent_1")

Y = 100                     # 台面高度（脚踩 y=100）
# 测试区整体平移到远离世界出生点的深海上空（种子 48290986：出生点 (0,0) 森林，(-1248,-800) 一带是深海）
OX = int(os.environ.get("MC_TEST_OX", "-1250"))
OZ = int(os.environ.get("MC_TEST_OZ", "-800"))
HOME = (OX + 10, 100, OZ + 10)  # 测试台中心格子
TOKEN = None
LOG = []


# ---------------------------------------------------------------- 基础工具
def read_secret(env, name):
    """先看环境变量，再看脚本同目录下的同名文件（方便不把口令留在 shell 历史里）。"""
    if os.environ.get(env):
        return os.environ[env]
    try:
        with open(os.path.join(HERE, name)) as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def http(path, body=None, method="POST", timeout=120):
    url = API + "/" + path.lstrip("/")
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                headers={"Content-Type": "application/json"})
    if TOKEN:
        req.add_header("Authorization", "Bearer " + TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def call(path, body=None, method="POST", timeout=120):
    code, payload = http(path, body, method, timeout)
    LOG.append({"path": path, "args": body, "http": code,
                "ok": payload.get("ok"), "result": payload.get("result"),
                "error": payload.get("error")})
    return payload


def ok(path, body=None, method="POST", timeout=120):
    p = call(path, body, method, timeout)
    if not p.get("ok"):
        raise AssertionError(f"{path} failed: {json.dumps(p.get('error'), ensure_ascii=False)}")
    return p.get("result") or {}


def status():
    return ok("status", method="GET")


def inv():
    return ok("inventory", method="GET")


def counts():
    c = {}
    for it in inv().get("items", []):
        c[it["name"]] = c.get(it["name"], 0) + it["count"]
    return c


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


# ---------------------------------------------------------------- RCON
def _packet(rid, ptype, body):
    payload = struct.pack("<ii", rid, ptype) + body.encode() + b"\x00\x00"
    return struct.pack("<i", len(payload)) + payload


def _recv(sock):
    raw = b""
    while len(raw) < 4:
        chunk = sock.recv(4 - len(raw))
        if not chunk:
            raise OSError("rcon closed")
        raw += chunk
    (length,) = struct.unpack("<i", raw)
    body = b""
    while len(body) < length:
        chunk = sock.recv(length - len(body))
        if not chunk:
            raise OSError("rcon closed")
        body += chunk
    return struct.unpack("<ii", body[:8]), body[8:].rstrip(b"\x00").decode("utf-8", "replace")


# 所有 @e[...] 选择器都限定在测试区（OX/OZ 周围 ±100 格、全高度），清实体不会波及真人玩家那边。
# 难度 / 时间 / 天气 / 昼夜仍是全服设置：有真人在线时不要跑全量回归。
AREA_SEL = f"x={OX - 90},y=-64,z={OZ - 90},dx=220,dy=384,dz=220"


def rcon(cmd, timeout=25):
    if "@e[" in cmd and "x=" not in cmd and "distance=" not in cmd:
        cmd = cmd.replace("@e[", f"@e[{AREA_SEL},")
    with socket.create_connection((RCON_HOST, RCON_PORT), timeout=timeout) as s:
        s.sendall(_packet(1, 3, read_secret("RCON_PASSWORD", ".rcon-pass")))
        _recv(s)
        s.sendall(_packet(2, 2, cmd))
        return _recv(s)[1]


# ---------------------------------------------------------------- 环境
def tp(x, y, z):
    rcon(f"tp {USER} {x} {y} {z}")


def wait_pos(x, z, tol=2.0, alive=True):
    for _ in range(60):
        st = status()
        if alive and not st.get("alive"):
            raise AssertionError("bot died")
        if abs(st["pos"][0] - x) <= tol and abs(st["pos"][2] - z) <= tol:
            return st
        time.sleep(0.3)
    raise AssertionError(f"bot never reached {x},{z}: pos={status()['pos']} vehicle={status().get('in_vehicle')}")


def give(*items):
    for spec in items:
        rcon(f"give {USER} {spec}")
    names = [spec.split()[0] for spec in items]
    for _ in range(40):
        c = counts()
        if all(n in c for n in names):
            return c
        time.sleep(0.15)
    raise AssertionError(f"items never arrived: {names} (have {sorted(counts())})")


def settle(y=None, tries=60):
    """等落地：传送后 bot 要过一会儿才站稳，物理没落稳之前做 setblock/放置都会错位。"""
    for _ in range(tries):
        st = status()
        if not st.get("alive"):
            raise AssertionError("bot died")
        if st["on_ground"] and (y is None or abs(st["pos"][1] - y) < 0.6):
            return st
        time.sleep(0.25)
    raise AssertionError(f"bot did not settle (pos={status()['pos']})")


def block_at(x, y, z, tries=30):
    last = None
    for _ in range(tries):
        p = http("get_block", {"x": x, "y": y, "z": z})[1]
        if p.get("ok"):
            return p["result"]
        last = p.get("error")
        time.sleep(0.25)
    raise AssertionError(f"get_block({x},{y},{z}) failed: {last}")


def clean_player():
    for cmd in (f"effect clear {USER}", f"clear {USER}", f"effect give {USER} instant_health 1 10",
                f"effect give {USER} saturation 5 20"):
        try:
            rcon(cmd)
        except Exception as e:  # noqa: BLE001
            print(f"    (rcon warn {cmd}: {e})")


def setup_base():
    # 直接落在台面上（不要先 tp 到高空再掉下来：一次性 -40 格会让服务端发位置校正，
    # 而 mineflayer 在 1.21.11 回的 accept_teleportation 包会被服务端判为无法解码，直接把 bot 踢掉）
    tp(HOME[0] + 0.5, Y, HOME[2] + 0.5)
    time.sleep(1.5)
    rcon(f"fill {OX-4} {Y-1} {OZ-4} {OX+26} {Y-1} {OZ+26} stone")
    rcon(f"fill {OX-4} {Y} {OZ-4} {OX+26} {Y+10} {OZ+26} air")
    rcon("kill @e[type=!player]")
    rcon("weather clear")
    rcon("difficulty peaceful")
    rcon("gamerule doDaylightCycle false")
    rcon("time set day")
    wait_pos(HOME[0], HOME[2], tol=1.5)
    settle(Y)
    block_at(HOME[0], Y, HOME[2])
    check(block_at(HOME[0], Y - 1, HOME[2])["name"] == "stone", "test platform was not created")
    clean_player()


def goto_home():
    if status().get("in_vehicle"):
        try:
            call("dismount", {})
        except Exception:  # noqa: BLE001
            pass
    tp(HOME[0] + 0.5, Y, HOME[2] + 0.5)
    wait_pos(HOME[0], HOME[2], tol=1.5)
    settle(Y)


def pos_of():
    p = status()["pos"]
    return [int(p[0] // 1), int(p[1] // 1), int(p[2] // 1)]


# ---------------------------------------------------------------- 测试项
TESTS = {}


def test(name):
    def deco(fn):
        TESTS[name] = fn
        return fn
    return deco


@test("probe")
def t_probe():
    st = status()
    need = ["effects", "on_fire", "is_sleeping", "in_water", "submerged", "in_lava",
            "in_vehicle", "sneaking", "blocking", "using_item", "armor_points",
            "xp_progress", "offhand", "thundering"]
    missing = [k for k in need if k not in st]
    check(not missing, f"status missing fields: {missing}")
    return {"pos": st["pos"], "field_count": len(st)}


@test("where")
def t_where():
    trace = []
    for _ in range(6):
        st = status()
        trace.append([st["pos"], st["on_ground"], st["in_water"]])
        time.sleep(1.0)
    blocks = {y: block_at(HOME[0], y, HOME[2])["name"] for y in range(96, 104)}
    return {"trace": trace, "blocks": blocks}


@test("events_dump")
def t_events_dump():
    ev = ok("events", {"since": 0, "limit": 300})
    hurts = [e for e in ev["events"] if e["type"] in ("hurt", "death")]
    return {"hurts": len(hurts), "sample": hurts[-5:], "types": sorted({e["type"] for e in ev["events"]})}


@test("effects")
def t_effects():
    rcon(f"effect give {USER} poison 25 1")
    time.sleep(0.6)
    st = status()
    names = {e["name"]: e for e in st["effects"]}
    check("poison" in names, f"poison missing: {st['effects']}")
    check(names["poison"]["level"] == 2, f"level wrong: {names['poison']}")
    check(names["poison"]["duration_s"] > 0, "duration missing")
    rcon(f"effect clear {USER}")
    time.sleep(0.6)
    check(status()["effects"] == [], "effects not cleared")
    return {"seen": names["poison"]}


@test("on_fire")
def t_on_fire():
    x, y, z = pos_of()
    rcon(f"effect give {USER} fire_resistance 30 1")
    rcon(f"setblock {x} {y} {z} fire")
    time.sleep(1.2)
    burning = status()["on_fire"]
    rcon(f"setblock {x} {y} {z} air")
    rcon(f"effect clear {USER}")
    check(burning, "on_fire stayed false while standing in fire")
    cleared = False
    for _ in range(40):
        time.sleep(0.4)
        if not status()["on_fire"]:
            cleared = True
            break
    check(cleared, "on_fire did not clear after leaving the fire")
    return {"on_fire": burning}


@test("water")
def t_water():
    # 角落挖一个 2 深的水池：y-1 和 y 是水，站进去头部在水里
    rcon(f"fill {OX+20} {Y-1} {OZ+20} {OX+22} {Y+1} {OZ+22} water")
    tp(OX + 21.5, Y, OZ + 21.5)
    wait_pos(OX + 21, OZ + 21)
    time.sleep(1.0)
    st = status()
    rcon(f"fill {OX+20} {Y-1} {OZ+20} {OX+22} {Y+1} {OZ+22} air")
    rcon(f"fill {OX+20} {Y-1} {OZ+20} {OX+22} {Y-1} {OZ+22} stone")
    tp(HOME[0] + 0.5, Y, HOME[2] + 0.5)
    wait_pos(HOME[0], HOME[2])
    settle(Y)
    check(st["in_water"], f"in_water false while submerged: {st['pos']} feet/head")
    check(st["submerged"], "submerged false with head under water")
    return {"in_water": st["in_water"], "submerged": st["submerged"], "oxygen": st["oxygen"]}


@test("lava")
def t_lava():
    rcon(f"effect give {USER} fire_resistance 30 1")
    rcon(f"setblock {OX+24} {Y} {OZ+24} lava")
    tp(OX + 24.5, Y, OZ + 24.5)
    wait_pos(OX + 24, OZ + 24)
    time.sleep(1.0)
    hot = status()["in_lava"]
    tp(HOME[0] + 0.5, Y, HOME[2] + 0.5)
    rcon(f"setblock {OX+24} {Y} {OZ+24} air")
    rcon(f"effect clear {USER}")
    settle(Y)
    check(hot, "in_lava false while standing in lava")
    return {"in_lava": hot}


@test("xp_armor")
def t_xp_armor():
    rcon(f"xp add {USER} 30 points")
    rcon(f"item replace entity {USER} armor.head with iron_helmet")
    rcon(f"item replace entity {USER} armor.chest with diamond_chestplate")
    rcon(f"item replace entity {USER} armor.legs with iron_leggings")
    rcon(f"item replace entity {USER} armor.feet with iron_boots")
    time.sleep(1.0)
    st = status()
    # iron 2 + diamond 8 + iron 5 + iron 2 = 17
    check(st["armor_points"] == 17, f"armor_points={st['armor_points']} expected 17")
    for slot in ("head", "chest", "legs", "feet"):
        rcon(f"item replace entity {USER} armor.{slot} with air")
    return {"xp_level": st["xp_level"], "xp_progress": st["xp_progress"], "armor_points": st["armor_points"]}


@test("weather")
def t_weather():
    rcon("weather thunder")
    time.sleep(1.5)
    check(status()["thundering"], "thundering false during thunder")
    rcon("weather clear")
    cleared = False
    for _ in range(30):
        time.sleep(0.4)
        if not status()["thundering"]:
            cleared = True
            break
    check(cleared, "thundering did not clear")
    return {"thundering": True}


@test("posture")
def t_posture():
    goto_home()
    r = ok("posture", {"sneak": True})
    check(r["sneaking"], "posture sneak did not apply")
    check(status()["sneaking"], "status.sneaking false after posture")
    ok("move_to", {"x": status()["pos"][0] + 2, "z": status()["pos"][2], "range": 1})
    check(status()["sneaking"], "sneak lost after an action (applyPosture broken)")
    r = ok("posture", {})
    check(not r["sneaking"], "posture {} did not reset")

    give("shield")
    r = ok("posture", {"shield": True})
    st = status()
    check(r["blocking"] and st["blocking"], "shield not raised")
    check(st["offhand"] and st["offhand"]["name"] == "shield", "shield not in offhand")
    r = ok("posture", {})
    check(not r["blocking"], "shield not lowered")
    clean_player()
    return {"sneak_persisted": True, "shield": True}


@test("place_on_chest")
def t_place_chest():
    goto_home()
    x, y, z = pos_of()
    cell = None
    for dx, dz in ((2, 0), (-2, 0), (0, 2), (0, -2), (3, 0), (0, -3)):
        b = block_at(x + dx, y, z + dz)
        below = block_at(x + dx, y - 1, z + dz)
        if b["name"] == "air" and below["name"] not in ("air", "water", "lava"):
            cell = (x + dx, y, z + dz)
            break
    check(cell, "no free cell with solid ground next to bot")
    give("chest", "cobblestone")
    r = ok("place", {"item": "chest", "x": cell[0], "y": cell[1], "z": cell[2]})
    check(r["sneaked"] is True, "place did not report sneaked")
    above = (cell[0], cell[1] + 1, cell[2])
    r = ok("place", {"item": "cobblestone", "x": above[0], "y": above[1], "z": above[2]})
    b = block_at(*above)
    check(b["name"] == "cobblestone", f"block on chest is {b['name']}")
    check(status()["busy"] is None, "window left the action stuck")
    rcon(f"setblock {cell[0]} {cell[1]} {cell[2]} air")
    rcon(f"setblock {above[0]} {above[1]} {above[2]} air")
    clean_player()
    return {"chest": cell, "placed_on_top": b["name"], "sneaked": r.get("sneaked")}


@test("feed_breed")
def t_feed_breed():
    goto_home()
    x, y, z = pos_of()
    rcon(f"summon cow {x+2} {y} {z+3} {{PersistenceRequired:1b}}")
    rcon(f"summon cow {x+4} {y} {z+3} {{PersistenceRequired:1b}}")
    time.sleep(0.8)
    ents = ok("get_entities", {"radius": 12, "types": ["cow"]})["entities"]
    check(len(ents) >= 2, f"cows not visible: {ents}")
    give("wheat", "wheat")
    fed = []
    for e in ents[:2]:
        fed.append(ok("interact", {"entity_id": e["id"], "item": "wheat"}))
    time.sleep(3.0)
    adv = ok("advancements", {"ids": ["minecraft:husbandry/breed_an_animal"], "include_criteria": False})
    done = [a for a in adv["advancements"] if a["status"] == "completed"]
    check(done, f"breed_an_animal not completed: {json.dumps(adv['advancements'], ensure_ascii=False)}")
    rcon("kill @e[type=cow]")
    rcon("kill @e[type=cow]")
    clean_player()
    return {"fed": len(fed), "advancement": done[0]["id"]}


@test("boat")
def t_boat():
    goto_home()
    give("oak_boat")
    st = status()
    r = ok("use_item", {"item": "oak_boat", "target": {"x": st["pos"][0] + 4, "y": Y, "z": st["pos"][2]}})
    check(r.get("entity", {}).get("id"), f"boat not placed: {r}")
    time.sleep(0.5)
    r2 = ok("interact", {"entity_id": r["entity"]["id"]})
    check(r2.get("in_vehicle"), f"not riding after interact: {r2}")
    check(status()["in_vehicle"], "status.in_vehicle empty while riding")
    r3 = ok("dismount", {})
    check(r3["dismounted"], "dismount failed")
    check(status()["in_vehicle"] is None, "still in vehicle after dismount")
    rcon("kill @e[type=oak_boat]")
    clean_player()
    return {"placed": r["entity"], "mounted": r2["in_vehicle"], "dismounted": True}


@test("boat_drive")
def t_boat_drive():
    """骑乘掌舵：move_to 在骑乘态应该自己发 vehicle_move 把船开过去。"""
    goto_home()
    x, y, z = pos_of()
    # 石台旁边挖 1 格深的水渠（船放在水里才开得动）
    rcon(f"fill {x+2} {y} {z-1} {x+22} {y} {z+1} water")
    rcon("kill @e[type=oak_boat]")
    time.sleep(0.3)
    give("oak_boat")
    r = ok("use_item", {"item": "oak_boat", "target": {"x": x + 3, "y": y, "z": z}})
    check(r.get("entity", {}).get("id"), f"boat not placed in water: {r}")
    time.sleep(0.5)
    got = {}
    for _ in range(3):
        got = ok("interact", {"entity_id": r["entity"]["id"]})
        if got.get("in_vehicle"):
            break
        time.sleep(0.8)
    check(got.get("in_vehicle"), f"not riding after interact: {got}")
    move = ok("move_to", {"x": x + 18, "z": z, "range": 1.5, "timeout": 45000}, timeout=70)
    after = status()["pos"]
    check(move.get("drove"), f"move_to did not use vehicle mode: {move}")
    check(after[0] > x + 10, f"boat barely moved: {[x, z]} -> {after}")
    check(status()["in_vehicle"], "fell off while driving")
    ok("dismount", {})
    rcon("kill @e[type=oak_boat]")
    rcon(f"fill {x+2} {y} {z-1} {x+22} {y} {z+1} air")
    clean_player()
    return {"from": [x, z], "to": after, "dist": move.get("dist"), "ms": move.get("ms")}


@test("boat_stall")
def t_boat_stall():
    """stalled 看门狗：大片水面上下船，周围没有陆地，服务端只能把人放在船顶判定箱上。
    这时 pathfinder 以前会原地转圈、一直占着动作锁；现在 move_to 必须在看门狗时限内返回
    （成功或 stalled，绝不能拖到 timeout），且返回后动作锁已释放。"""
    goto_home()
    ox, oz = OX + 50, OZ + 50        # 离石台 40 格（视距内，区块随 bot 加载）
    r0 = 12
    # 玻璃外壳 + 内部 5 格深水，水面在 Y-1；岛是离中心 8 格的 2x2 石柱，顶面与水面齐平
    rcon(f"fill {ox-r0} {Y-6} {oz-r0} {ox+r0} {Y+6} {oz+r0} air")
    rcon(f"fill {ox-r0} {Y-6} {oz-r0} {ox+r0} {Y-1} {oz+r0} glass hollow")
    rcon(f"fill {ox-r0+1} {Y-5} {oz-r0+1} {ox+r0-1} {Y-1} {oz+r0-1} water")
    rcon(f"fill {ox+8} {Y-5} {oz} {ox+9} {Y-1} {oz+1} stone")
    rcon("kill @e[type=oak_boat]")
    out = {}
    try:
        tp(ox + 0.5, Y, oz + 0.5)
        wait_pos(ox, oz)
        ok("posture", {"jump": True})        # 踩水浮在水面
        time.sleep(2.0)
        give("oak_boat")
        r = ok("use_item", {"item": "oak_boat", "target": {"pos": [ox + 2, Y - 1, oz]}, "stop_on": []})
        check(r.get("entity", {}).get("id"), f"boat not placed: {r}")
        ok("posture", {})
        time.sleep(0.5)
        got = {}
        for _ in range(3):
            got = ok("interact", {"entity_id": r["entity"]["id"]})
            if got.get("in_vehicle"):
                break
            time.sleep(0.8)
        check(got.get("in_vehicle"), f"not riding: {got}")
        ok("dismount", {})
        time.sleep(1.5)
        st = status()
        out["after_dismount"] = {"pos": st["pos"], "on_ground": st["on_ground"], "in_water": st["in_water"]}
        check(st["in_vehicle"] is None, "still riding after dismount")
        # 用户反馈的原场景：站在船顶时船被移除（被 agent 自己打掉 / 消失）
        rcon("kill @e[type=oak_boat]")
        time.sleep(1.5)
        st = status()
        out["after_boat_removed"] = {"pos": st["pos"], "on_ground": st["on_ground"], "in_water": st["in_water"]}

        t0 = time.time()
        code, p = http("move_to", {"x": ox + 8, "y": Y, "z": oz, "range": 1, "timeout": 30000}, timeout=60)
        dt = round(time.time() - t0, 1)
        err = p.get("error") or {}
        out["move_to"] = {"s": dt, "ok": p.get("ok"), "code": err.get("code"), "message": err.get("message")}
        check(p.get("ok") or err.get("code") in ("stalled", "path_not_found"),
              f"move_to failed with an unexpected code: {err}")
        check(dt < 25, f"move_to held the action lock for {dt}s (watchdog is 8s)")
        st = status()
        check(st["busy"] is None, f"action lock still held: {st['busy']}")
        # 动作锁释放后，下一个动作必须能马上执行（不是 busy）
        nxt = http("control", {"jump": True, "ms": 300})[1]
        check(nxt.get("ok"), f"follow-up action failed: {nxt.get('error')}")
        out["branch"] = "reached" if p.get("ok") else err.get("code")
    finally:
        try:
            http("posture", {})
            goto_home()
        finally:
            rcon("kill @e[type=oak_boat]")
            rcon(f"fill {ox-r0} {Y-6} {oz-r0} {ox+r0} {Y+6} {oz+r0} air")
            clean_player()
    return out


@test("stall_hitbox")
def t_stall_hitbox():
    """stalled 看门狗的确定性复现：prismarine-physics 只算方块碰撞、不算实体，
    服务端却拿船的判定箱挡人。1 宽 2 高、两头封死的石管里横一条船，目标在船后面：
    客户端以为能穿过去，服务端每次都把人拉回来，pathfinder 原地转圈。
    move_to 必须以 stalled 返回（不是拖到 timeout），动作锁释放，bot 不被踢。"""
    goto_home()
    x0, x1, zc = OX + 12, OX + 24, OZ + 2
    rcon(f"fill {x0} {Y} {zc-1} {x1} {Y+2} {zc+1} stone")
    rcon(f"fill {x0+1} {Y} {zc} {x1-1} {Y+1} {zc} air")
    rcon("kill @e[type=oak_boat]")
    out = {}
    try:
        tp(x0 + 1.5, Y, zc + 0.5)
        wait_pos(x0 + 1, zc, tol=1.0)
        settle(Y)
        rcon(f"summon oak_boat {x0 + 6.5} {Y} {zc + 0.5}")
        time.sleep(1.0)
        boats = ok("get_entities", {"radius": 10, "types": ["oak_boat"]})["entities"]
        check(boats, "boat not visible in the tube")
        t0 = time.time()
        code, p = http("move_to", {"x": x1 - 2, "y": Y, "z": zc, "range": 0.5, "timeout": 30000}, timeout=60)
        dt = round(time.time() - t0, 1)
        err = p.get("error") or {}
        st = status()
        out = {"s": dt, "code": err.get("code"), "message": err.get("message"),
               "pos": st["pos"], "boat": boats[0]["pos"]}
        check(err.get("code") == "stalled", f"expected stalled, got ok={p.get('ok')} {err} pos={st['pos']}")
        check(7 <= dt < 20, f"stalled after {dt}s (watchdog is 8s)")
        check(st["busy"] is None, f"action lock still held: {st['busy']}")
        check(st.get("ready") is not False and st.get("alive"), "bot kicked or dead after the stall")
        nxt = http("look", {"yaw": 0, "pitch": 0})[1]
        check(nxt.get("ok"), f"follow-up action failed: {nxt.get('error')}")
    finally:
        rcon("kill @e[type=oak_boat]")
        rcon(f"fill {x0} {Y} {zc-1} {x1} {Y+2} {zc+1} air")
        goto_home()
    return out


@test("strider_drive")
def t_strider_drive():
    """炽足兽：岩浆上掌舵，同时验证需要手持诡异菌钓竿才认控制。
    整个装置建在石台上方 1~2 格（原本是空气），拆掉时填空气即可精确还原。"""
    goto_home()
    x, y, z = pos_of()
    lx = x + 6
    ty = y + 1                      # 底座这一层
    # 在岩浆槽上方 dismount 会直接掉进岩浆：不给抗火就会带着 15 s 的火进入后面的用例
    rcon(f"effect give {USER} fire_resistance 60 0")
    rcon(f"fill {lx-2} {ty} {z-2} {lx+22} {ty} {z+2} stone")     # 地板
    rcon(f"fill {lx} {ty+1} {z-1} {lx+20} {ty+1} {z+1} lava")    # 1 格深岩浆槽
    rcon(f"fill {lx-2} {ty+1} {z-1} {lx-1} {ty+1} {z+1} stone")  # 站台
    rcon("kill @e[type=strider]")
    time.sleep(0.3)
    rcon(f"summon strider {lx+0.5} {ty+1} {z+0.5}")
    time.sleep(1.0)
    ents = ok("get_entities", {"radius": 16, "types": ["strider"]})["entities"]
    check(ents, f"summoned strider not visible at {lx}")
    rcon(f"tp {USER} {lx-1.5} {ty+1} {z+0.5}")
    time.sleep(0.8)
    # 炽足兽要先上鞍才能骑（和猪一样），再右键上兽
    give("saddle")
    ok("interact", {"entity_id": ents[0]["id"], "item": "saddle"})
    time.sleep(0.5)
    r = {}
    for _ in range(3):
        r = ok("interact", {"entity_id": ents[0]["id"]})
        if r.get("in_vehicle"):
            break
        time.sleep(0.8)
    check(r.get("in_vehicle"), f"not riding strider: {r}")
    give("warped_fungus_on_a_stick")
    ok("equip", {"item": "warped_fungus_on_a_stick"})
    move = ok("move_to", {"x": lx + 16, "z": z, "range": 1.5, "timeout": 45000}, timeout=70)
    after = status()["pos"]
    check(move.get("drove"), f"move_to did not use vehicle mode: {move}")
    check(after[0] > lx + 8, f"strider barely moved: {[lx, z]} -> {after}")
    ok("dismount", {})
    rcon("kill @e[type=strider]")
    rcon(f"fill {lx-2} {ty} {z-2} {lx+22} {ty+1} {z+2} air")
    goto_home()
    # 抗火只是不掉血，火还在烧：踩一下水把火浇灭，再清掉抗火
    rcon(f"setblock {HOME[0]} {Y} {HOME[2]} water")
    for _ in range(20):
        time.sleep(0.25)
        if not status()["on_fire"]:
            break
    rcon(f"setblock {HOME[0]} {Y} {HOME[2]} air")
    check(not status()["on_fire"], "still burning after the strider ride")
    clean_player()
    return {"from": [lx, z], "to": after, "dist": move.get("dist"), "ms": move.get("ms")}


@test("pearl")
def t_pearl():
    goto_home()
    before = status()["pos"]
    give("ender_pearl")
    # 先瞄一个 6 格外的点，保证珍珠真的飞出去（朝脚下扔会原地炸开）
    r = ok("use_item", {"item": "ender_pearl", "target": {"x": before[0] + 6, "y": before[1] + 1, "z": before[2]}})
    check(r.get("thrown"), f"pearl not thrown: {r}")
    time.sleep(0.5)
    after = status()["pos"]
    check(r["teleported"], f"pearl did not teleport: {r}")
    check(after != before, "position unchanged after pearl")
    check(status()["alive"], "bot died from the pearl")
    clean_player()
    return {"from": before, "to": after}


@test("eye")
def t_eye():
    goto_home()
    give("ender_eye")
    r = ok("use_item", {"item": "ender_eye"})
    check(r.get("thrown"), f"eye not thrown: {r}")
    check("bearing_deg" in r, f"no bearing: {r}")
    check("eye_vector" in r, f"no eye_vector: {r}")
    rcon("kill @e[type=eye_of_ender]")
    clean_player()
    return {"bearing_deg": r["bearing_deg"], "eye_vector": r["eye_vector"]}


@test("milk")
def t_milk():
    goto_home()
    rcon(f"effect give {USER} poison 20 0")
    time.sleep(0.6)
    check(status()["effects"], "poison missing before milk")
    give("milk_bucket")
    r = ok("use_item", {"item": "milk_bucket"})
    check(r["effects"] == [], f"milk did not clear effects: {r['effects']}")
    check(status()["effects"] == [], "status still shows poison after milk")
    return {"used": r["used"]}


@test("golden_apple")
def t_golden_apple():
    goto_home()
    give("golden_apple")
    r = ok("use_item", {"item": "golden_apple"})
    names = {e["name"] for e in r["effects"]}
    check("absorption" in names or "regeneration" in names, f"no absorption/regeneration: {r['effects']}")
    clean_player()
    return {"effects": sorted(names)}


@test("spyglass")
def t_spyglass():
    goto_home()
    x, y, z = pos_of()
    rcon(f"summon parrot {x+6} {y} {z+3} {{PersistenceRequired:1b}}")
    time.sleep(0.8)
    ents = ok("get_entities", {"radius": 16, "types": ["parrot"]})["entities"]
    check(ents, "parrot not visible")
    give("spyglass")
    r = ok("use_item", {"item": "spyglass", "target": {"entity_id": ents[0]["id"]}, "ms": 1200})
    check(r.get("observed_ms"), f"spyglass did not run: {r}")
    time.sleep(2.0)
    adv = ok("advancements", {"ids": ["minecraft:adventure/spyglass_at_parrot"], "include_criteria": False})
    done = [a for a in adv["advancements"] if a["status"] == "completed"]
    check(done, "spyglass_at_parrot not completed")
    rcon("kill @e[type=parrot]")
    clean_player()
    return {"advancement": done[0]["id"]}


@test("fishing")
def t_fishing():
    goto_home()
    x, y, z = pos_of()
    # 台面上挖 3x3x3 水池，站在池边；水够深浮标才会稳定在水里
    # 水下会刷溺尸并朝人扔三叉戟，钓鱼期间先把难度调成和平
    rcon("difficulty peaceful")
    rcon(f"fill {x+2} {y-3} {z+2} {x+4} {y-1} {z+4} water")
    give("fishing_rod")
    tp(x + 1.5, y, z + 3.5)
    settle(y)
    # 单次、默认 stop_on；期间若有 hurt，把伤害来源一起记下来，便于排查
    seq0 = ok("events", {"since": 0, "limit": 500})["last_seq"]
    body = {"item": "fishing_rod", "target": {"pos": [x + 3, y - 2, z + 3]}, "timeout": 55000}
    code, payload = http("use_item", body, timeout=90)
    hurts = [e for e in ok("events", {"since": seq0, "limit": 500})["events"] if e["type"] == "hurt"]
    if not payload.get("ok"):
        raise AssertionError(f"use_item failed: {json.dumps(payload.get('error'), ensure_ascii=False)} hurts={hurts}")
    r = payload["result"] or {}
    check(r.get("caught"), f"no catch: {r}")
    rcon(f"fill {x+2} {y-3} {z+2} {x+4} {y-1} {z+4} air")
    rcon(f"fill {x+2} {y-1} {z+2} {x+4} {y-1} {z+4} stone")
    rcon("difficulty normal")
    goto_home()
    clean_player()
    return {"caught": r["caught"], "wait_ms": r["wait_ms"], "casts": r.get("casts"),
            "false_bites": r.get("false_bites"), "interrupted_by": r.get("interrupted_by"), "hurts": hurts}


@test("sleep")
def t_sleep():
    goto_home()
    x, y, z = pos_of()
    rcon("gamerule doDaylightCycle false")
    rcon("time set midnight")
    cell = None
    for dx, dz in ((2, 0), (-2, 0), (0, 2), (0, -2), (3, 0)):
        for dy in (0, 1):
            b = block_at(x + dx, y + dy, z + dz)
            b2 = block_at(x + dx, y + dy, z + dz + 1)
            below = block_at(x + dx, y + dy - 1, z + dz)
            if b["name"] == "air" and b2["name"] == "air" and below["name"] != "air":
                cell = (x + dx, y + dy, z + dz)
                break
        if cell:
            break
    check(cell, "no room for a bed")
    rcon(f"setblock {cell[0]} {cell[1]} {cell[2]} red_bed[part=foot,facing=south]")
    rcon(f"setblock {cell[0]} {cell[1]} {cell[2]+1} red_bed[part=head,facing=south]")
    time.sleep(0.4)
    r = ok("interact", {"x": cell[0], "y": cell[1], "z": cell[2]})
    check(r.get("slept"), f"did not sleep: {r}")
    check(status()["is_sleeping"], "status.is_sleeping false")
    r2 = ok("interact", {"x": cell[0], "y": cell[1], "z": cell[2]})
    check(r2.get("woke"), f"did not wake: {r2}")
    # 只给 1.5 s：只有 bot 一个人在线时，全员入睡 100 tick（5 s）后服务端会跳夜把人叫醒，
    # 等太久就分不清是起床包生效还是跳夜（1.3.3 及以前起床包无效，就是这样被掩盖的）
    for _ in range(6):
        if not status()["is_sleeping"]:
            break
        time.sleep(0.25)
    check(not status()["is_sleeping"], "still sleeping")
    rcon(f"setblock {cell[0]} {cell[1]} {cell[2]} air")
    rcon(f"setblock {cell[0]} {cell[1]} {cell[2]+1} air")
    # 拆掉床脚时床头会因方块更新被打掉、掉出一张床；不清掉的话 bot 之后会捡起来拿在手上，
    # 让后面"空手攻击间隔 250ms"之类的断言偶发失败
    rcon("kill @e[type=item]")
    rcon("time set day")
    return {"bed": cell}


@test("bridge")
def t_bridge():
    by = 120
    # 先把区块加载出来再 fill，否则清理不掉上一轮留下的桥
    tp(OX + 40.5, by + 8, OZ + 0.5)
    wait_pos(OX + 40, OZ)
    time.sleep(2.0)
    for _ in range(3):
        rcon(f"fill {OX+37} {by-3} {OZ-7} {OX+43} {by+6} {OZ+9} air")
        time.sleep(0.6)
        if block_at(OX + 40, by - 1, OZ - 1)["name"] == "air":
            break
    rcon(f"setblock {OX+40} {by-1} {OZ} stone")
    tp(OX + 40.5, by, OZ + 0.5)
    wait_pos(OX + 40, OZ)
    settle(by)
    check(block_at(OX + 40, by - 1, OZ)["name"] == "stone", "bridge start block missing")
    give("cobblestone", "cobblestone", "cobblestone")
    ok("posture", {"sneak": True})
    # 连续往前铺 3 格再走过去：验证潜行在多次调用之间保持、且不会从桥上掉下去
    built = []
    for i in (1, 2, 3):
        tgt = (OX + 40, by - 1, OZ - i)
        b = block_at(*tgt)
        check(b["name"] == "air", f"bridge cell {tgt} not empty: {b['name']}")
        built.append(ok("place", {"item": "cobblestone", "x": tgt[0], "y": tgt[1], "z": tgt[2]}))
        check(status()["sneaking"], "sneak dropped during bridging")
    ok("move_to", {"x": 40, "z": -3, "range": 0.7})
    st = status()
    check(abs(st["pos"][2] - OZ + 3) < 1.0, f"bot did not walk out on the bridge: z={st['pos'][2]}")
    check(abs(st["pos"][1] - by) < 1.2, f"bot fell off the bridge: y={st['pos'][1]}")
    ok("posture", {})
    rcon(f"fill {OX+36} {by-3} {OZ-6} {OX+44} {by+6} {OZ+8} air")
    tp(HOME[0] + 0.5, Y, HOME[2] + 0.5)
    wait_pos(HOME[0], HOME[2])
    settle(Y)
    return {"blocks": len(built), "y": st["pos"][1]}


@test("pos_alias")
def t_pos_alias():
    st = status()
    p = [int(v // 1) for v in st["pos"]]   # 负坐标要向下取整
    payload = None
    for _ in range(30):
        code, payload = http("get_block", {"pos": [p[0], p[1] + 3, p[2]]})
        if payload.get("ok"):
            break
        time.sleep(0.25)
    check(payload.get("ok"), f"pos alias not accepted: {payload}")
    return {"block_above": payload["result"]["name"]}


@test("consume_gone")
def t_consume_gone():
    code, payload = http("consume", {"item": "bread"})
    check(code == 404, f"/consume still routed: {code}")
    check(payload["error"]["code"] == "unknown_api", f"unexpected: {payload}")
    return {"http": code, "code": payload["error"]["code"]}


@test("envelope")
def t_envelope():
    code, p = http("dig", {"x": 0, "y": -9999, "z": 0})
    check(code == 200, f"business error returned HTTP {code}")
    check(p["ok"] is False and p["error"]["code"], f"bad error envelope: {p}")
    st = http("status", method="GET")[1]
    check("ms" in st and "result" in st, f"success envelope missing ms/result: {list(st)}")
    return {"error_code": p["error"]["code"], "ms": st["ms"]}


@test("guards")
def t_guards():
    """输入校验：命令聊天 / 事件分页 / 坐标校验 / 半径校验 / 窗口扁平 target。"""
    goto_home()
    x, y, z = pos_of()
    out = {}

    code, p = http("chat", {"message": "/not-a-real-command"})
    check(p["error"]["code"] == "bad_args", f"chat command not rejected: {p}")
    code, p = http("chat", {"message": "x" * 101})
    check(p["error"]["code"] == "bad_args", f"over-long chat not rejected: {p}")
    r = ok("chat", {"message": "validation-check"})
    check(r["sent"], "normal chat failed")
    code, p = http("chat", {"message": "second message"})
    check(p["error"]["code"] == "rate_limited", f"chat not rate limited: {p}")

    res = ok("events", {"since": 0, "limit": 3})
    check(len(res["events"]) <= 3, f"limit ignored: {len(res['events'])}")
    check("has_more" in res, "events missing has_more")
    res2 = ok("events", {"since": res["last_seq"], "limit": 3})
    check(all(e["seq"] > res["last_seq"] for e in res2["events"]), "since ignored")
    code, p = http("events", {"since": -1})
    check(p["error"]["code"] == "bad_args", f"negative since not rejected: {p}")

    for bad in ({}, {"pos": []}, {"pos": [8, 99]}, {"x": "abc", "y": 99, "z": 20}):
        code, p = http("get_block", bad)
        check(p["error"]["code"] == "bad_args", f"get_block {bad} -> {p['error']['code']}")
    g = ok("get_block", {"pos": [x, y - 1, z]})
    check(g["name"], "get_block on a valid pos failed")

    code, p = http("find_blocks", {"radius": -1, "limit": 2})
    check(p["error"]["code"] == "bad_args", f"negative radius accepted: {p}")

    code, p = http("window/view", {"pos": [x, y - 1, z]})
    check(p.get("error", {}).get("code") == "no_window", f"flat target not parsed: {p}")
    out["checks"] = 12
    return out


@test("primitives")
def t_primitives():
    """底层原语：/control、/look、posture.jump 踩水、attack max_hits、白天点床。"""
    clean_player()
    goto_home()
    x, y, z = pos_of()
    out = {}

    r = ok("control", {"forward": True, "ms": 600})
    check(r["moved"] > 0.2, f"/control moved nothing: {r}")
    out["control"] = r["moved"]
    ok("stop", {})

    r = ok("look", {"yaw": 1.2, "pitch": -0.1})
    check(abs(r["yaw"] - 1.2) < 0.25, f"/look yaw wrong: {r}")
    out["look"] = [r["yaw"], r["pitch"]]

    # 水里持续跳跃应该浮住，而不是一路沉底
    rcon(f"fill {x+2} {y-5} {z+2} {x+4} {y-5} {z+4} stone")
    rcon(f"fill {x+2} {y-4} {z+2} {x+4} {y} {z+4} water")
    tp(x + 3.5, y - 2, z + 3.5)
    time.sleep(1.0)
    ok("posture", {"jump": True})
    time.sleep(0.6)
    y1 = status()["pos"][1]
    time.sleep(3.0)
    st = status()
    y2 = st["pos"][1]
    check(st.get("jumping") is True, f"status.jumping false: {st.get('jumping')}")
    check(y2 > y1 - 1.5, f"bot sank while holding jump: {y1} -> {y2}")
    out["float"] = [y1, y2]
    ok("posture", {})
    rcon(f"fill {x+2} {y-4} {z+2} {x+4} {y} {z+4} air")
    rcon(f"fill {x+2} {y-6} {z+2} {x+4} {y-6} {z+4} air")
    goto_home()

    # 空手 max_hits=1：只打一下就走，间隔按原版空手 250ms（先清掉地上掉落物和背包，保证真是空手）
    rcon("kill @e[type=item]")
    rcon(f"clear {USER}")
    time.sleep(0.5)
    rcon(f"summon cow {x+3} {y} {z+3} {{PersistenceRequired:1b}}")
    time.sleep(0.8)
    ents = ok("get_entities", {"radius": 12, "types": ["cow"]})["entities"]
    check(ents, "cow not visible")
    r = ok("attack", {"entity_id": ents[0]["id"], "max_hits": 1, "timeout": 8000})
    check(r["hits"] == 1, f"max_hits ignored: {r}")
    check(r["interval_ms"] == 250, f"fist interval not 250ms: {r}")
    out["attack"] = [r["hits"], r["interval_ms"]]
    rcon("kill @e[type=cow]")

    # 白天点床：仍然发右键包（能绑重生点），不再本地 cannot_sleep
    rcon("time set noon")
    rcon(f"setblock {x+4} {y-1} {z+4} minecraft:red_bed[part=head,facing=south]")
    rcon(f"setblock {x+4} {y-1} {z+3} minecraft:red_bed[part=foot,facing=south]")
    time.sleep(0.4)
    r = ok("interact", {"pos": [x+4, y-1, z+4]})
    check(r.get("slept") is False and r.get("interacted") is True, f"daytime bed: {r}")
    out["bed"] = {"slept": r.get("slept"), "interacted": r.get("interacted")}
    rcon(f"setblock {x+4} {y-1} {z+4} air")
    rcon(f"setblock {x+4} {y-1} {z+3} air")
    rcon("kill @e[type=item]")
    clean_player()
    return out


@test("control_hit")
def t_control_hit():
    """/control 的 hit：按给定 yaw/pitch 原版左键，不寻路、不自动瞄准。
    命中牛（扣血）、背对时挥空且不挖方块、能打到 type=object 的船、参数校验。"""
    import math
    clean_player()
    goto_home()
    x, y, z = pos_of()
    rcon("kill @e[type=!player]")
    rcon(f"clear {USER}")
    out = {}

    def aim(target_pos, height):
        st = status()
        ex, ey, ez = st["pos"][0], st["pos"][1] + 1.62, st["pos"][2]
        dx, dy, dz = target_pos[0] - ex, target_pos[1] + height - ey, target_pos[2] - ez
        return math.atan2(-dx, -dz), math.atan2(dy, math.hypot(dx, dz))

    try:
        # 1) 牛在正东 2 格：3 下都要打在牛身上，且牛掉血（NoAI 免得它被打跑）
        rcon(f"summon cow {x + 2.5} {y} {z + 0.5} {{NoAI:1b,PersistenceRequired:1b}}")
        time.sleep(1.0)
        cows = ok("get_entities", {"radius": 6, "types": ["cow"]})["entities"]
        check(cows, "cow not visible")
        cow = cows[0]
        yaw, pitch = aim(cow["pos"], 0.7)
        r = ok("control", {"hit": 3, "yaw": yaw, "pitch": pitch, "stop_on": []})
        out["cow"] = {"hits": r["hits"], "interval": r["hit_interval_ms"], "ms": r["ms"]}
        check(len(r["hits"]) == 3, f"expected 3 swings: {r}")
        check(r["hit_interval_ms"] == 250, f"fist interval should be 250: {r['hit_interval_ms']}")
        check(all(h["entity"] and h["entity"]["id"] == cow["id"] for h in r["hits"]), f"not every swing hit the cow: {r['hits']}")
        check(r["moved"] < 0.3, f"hit-only control moved the bot: {r['moved']}")
        time.sleep(0.6)
        # 客户端拿不到生物血量，问服务端（牛满血 10）
        raw = rcon("data get entity @e[type=cow,limit=1,sort=nearest] Health")
        m = __import__("re").search(r"([0-9.]+)f?\s*$", raw.strip())
        hp = float(m.group(1)) if m else None
        out["cow"]["health_after"] = hp
        check(hp is not None and hp < 10, f"cow health did not drop (server says: {raw!r})")

        # 2) 背对牛：挥空，且脚下 / 面前方块不被挖
        r = ok("control", {"hit": True, "yaw": yaw + math.pi, "pitch": 0.6})
        miss = r["hits"][0]
        out["miss"] = miss
        check(miss["entity"] is None, f"facing away still hit something: {miss}")
        if miss.get("block"):
            bp = miss["block"]["pos"]
            check(block_at(*bp)["name"] == miss["block"]["name"], "a miss dug the block it looked at")
        rcon("kill @e[type=cow]")

        # 3) 船是 type=object，mineflayer 的 entityAtCursor 会漏掉；这里必须打得到
        rcon(f"summon oak_boat {x + 0.5} {y} {z + 2.5}")
        time.sleep(1.0)
        boats = ok("get_entities", {"radius": 6, "types": ["oak_boat"]})["entities"]
        check(boats, "boat not visible")
        yaw, pitch = aim(boats[0]["pos"], 0.3)
        r = ok("control", {"hit": 8, "yaw": yaw, "pitch": pitch, "stop_on": []})
        hit_ids = [h["entity"]["id"] for h in r["hits"] if h["entity"]]
        out["boat"] = {"hits_on_boat": hit_ids.count(boats[0]["id"]), "swings": len(r["hits"])}
        check(hit_ids and hit_ids[0] == boats[0]["id"], f"first swing did not hit the boat: {r['hits']}")
        time.sleep(0.6)
        out["boat"]["broken"] = not ok("get_entities", {"radius": 6, "types": ["oak_boat"]})["entities"]

        # 4) 参数校验
        for bad in ({"hit": 0}, {"hit": 21}, {"hit": "x"}, {"hit": 3, "hit_interval_ms": 1000, "ms": 500},
                    {"hit_interval_ms": 300, "forward": True}):
            p = http("control", bad)[1]
            check(p.get("error", {}).get("code") == "bad_args", f"control {bad} -> {p}")
        p = http("control", {"hit": 3, "hit_interval_ms": 1000, "ms": 500})[1]
        check(p["error"].get("required_ms") == 2050, f"required_ms missing: {p['error']}")
    finally:
        rcon("kill @e[type=!player]")
        clean_player()
    return out


@test("knockback")
def t_knockback():
    """挨打要被击退：1.21.9+ 的速度包是 lpVec3，mineflayer 4.39 多除了 8000，bot 曾经纹丝不动。
    来源用 marker（非生物，伤害不随难度缩放），在 bot 西边，服务端位置要朝 +x 移开 > 1 格。"""
    import re
    clean_player()
    goto_home()
    x, y, z = pos_of()
    rcon(f"gamemode survival {USER}")
    out = {}
    try:
        rcon("kill @e[type=marker]")
        rcon(f"summon marker {x - 1.5} {y} {z + 0.5} {{Tags:[kbsrc]}}")
        time.sleep(0.6)

        def spos():
            return [float(v) for v in re.findall(r"(-?\d+(?:\.\d+)?)d", rcon(f"data get entity {USER} Pos"))]
        p0 = spos()
        r = rcon(f"damage {USER} 1 minecraft:mob_attack by @e[type=marker,tag=kbsrc,limit=1]")
        check("Applied" in r, f"damage command failed: {r!r}")
        time.sleep(1.5)
        p1 = spos()
        out = {"dx": round(p1[0] - p0[0], 3), "dz": round(p1[2] - p0[2], 3)}
        check(out["dx"] > 1.0 and abs(out["dz"]) < 0.3, f"no knockback away from the attacker: {out}")
    finally:
        rcon("kill @e[type=marker]")
        clean_player()
    return out


@test("entity_push")
def t_entity_push():
    """被重叠的实体挤开：原版由客户端自己算，mineflayer 没实现，1.3.5 及以前 bot 推不动。
    NoAI 牛（自己不动）放在 bot 身边错开 0.35 格，3 s 内服务端位置要离开 > 0.3 格。"""
    import math
    import re
    clean_player()
    goto_home()
    x, y, z = pos_of()
    rcon("kill @e[type=cow]")
    rcon(f"summon cow {x + 3.5} {y} {z + 0.5} {{NoAI:1b,PersistenceRequired:1b,Tags:[pushtest]}}")
    time.sleep(1.0)
    try:
        p0 = [x + 3.5 + 0.25, y, z + 0.5 + 0.1]
        rcon(f"tp {USER} {p0[0]} {p0[1]} {p0[2]}")
        time.sleep(3)
        p1 = [float(v) for v in re.findall(r"(-?\d+(?:\.\d+)?)d", rcon(f"data get entity {USER} Pos"))]
        moved = round(math.hypot(p1[0] - p0[0], p1[2] - p0[2]), 3)
        check(moved > 0.3, f"bot was not pushed out of the cow: moved {moved}")
        return {"moved": moved}
    finally:
        rcon("kill @e[type=cow]")
        goto_home()


@test("busy")
def t_busy():
    goto_home()
    st = status()
    res = {}

    def slow():
        res["a"] = http("move_to", {"x": 24, "z": 24, "range": 1})

    t = threading.Thread(target=slow)
    t.start()
    time.sleep(0.5)
    code, p = http("move_to", {"x": st["pos"][0] + 6, "z": st["pos"][2], "range": 1})
    t.join(timeout=90)
    check(code == 200, f"busy returned HTTP {code}")
    check(p.get("ok") is False and p["error"]["code"] == "busy", f"expected busy: {p}")
    return {"http": code, "code": p["error"]["code"]}


@test("events")
def t_events():
    ev = ok("events", {"since": 0, "limit": 500})
    types = {e["type"] for e in ev["events"]}
    need = {"effect_start", "sleep", "wake", "vehicle"}
    missing = need - types
    check(not missing, f"missing event types: {missing}, have {sorted(types)}")
    check("seq" in ev["events"][0] and "t" in ev["events"][0], "event fields changed")
    return {"types": sorted(types), "count": len(ev["events"])}


# ---------------------------------------------------------------- 驱动
def login():
    global TOKEN
    payload = http("auth/login", {"username": USER, "password": read_secret("MC_AGENT_PASSWORD", ".agent-password")})[1]
    if not payload.get("ok"):
        raise SystemExit(f"login failed: {payload}")
    TOKEN = payload["token"]
    for _ in range(40):
        st = http("status", method="GET")[1]
        if st.get("ok") and st["result"].get("ready"):
            return st["result"]
        time.sleep(1)
    raise SystemExit("bot never became ready")


def main(argv):
    names = argv[1:] or ["all"]
    if names == ["all"]:
        names = [n for n in TESTS if n not in ("probe", "diag")]
    login()
    setup_base()
    print(json.dumps({"ready": True, "pos": status()["pos"]}, ensure_ascii=False))
    results = []
    try:
        for n in names:
            fn = TESTS.get(n)
            if not fn:
                results.append({"test": n, "ok": False, "detail": "unknown test"})
                continue
            started = time.time()
            try:
                detail = fn()
                results.append({"test": n, "ok": True, "ms": int((time.time() - started) * 1000), "detail": detail})
                print(f"PASS {n} ({int((time.time()-started)*1000)}ms)")
            except Exception as e:  # noqa: BLE001
                results.append({"test": n, "ok": False, "ms": int((time.time() - started) * 1000), "detail": str(e)})
                print(f"FAIL {n}: {e}")
                if not status().get("alive"):
                    tp(HOME[0] + 0.5, Y, HOME[2] + 0.5)
                    time.sleep(2)
                clean_player()
            sys.stdout.flush()
    finally:
        try:
            # 先把人放回台面再下线，否则玩家存档里会留一个卡在方块里的坐标，
            # 下次登录服务端要发位置校正
            if status().get("alive"):
                if status().get("in_vehicle"):
                    call("dismount", {})
                tp(HOME[0] + 0.5, Y, HOME[2] + 0.5)
                settle(Y)
            rcon("kill @e[type=!player]")
            rcon("weather clear")
            rcon("gamerule doDaylightCycle true")
            rcon("time set day")
            rcon("difficulty normal")
            http("disconnect", {})
            http("auth/logout", {})
        except Exception:  # noqa: BLE001
            pass
    passed = sum(1 for r in results if r["ok"])
    print(json.dumps({"passed": passed, "total": len(results), "results": results,
                      "calls": len(LOG)}, ensure_ascii=False, indent=1))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
