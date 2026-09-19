# -*- coding: utf-8 -*-
"""《工业革命·兰开夏》联机服务器（FastAPI）。

职责（对齐 PRD 12.1 服务器权威模型）：
- 大厅 / 房间 / 座位：同一局域网内多台设备各占一个座位
- 行动提交：以 engine 为唯一权威做第二层校验并执行，失败不改动状态
- 状态下发：按视角过滤（不泄露他人手牌），长轮询实现准实时同步
- SQLite 持久化，服务重启后对局仍在

启动（局域网）：
    python -m uvicorn app.main:app --host 0.0.0.0 --port 8765
浏览器访问 http://<本机IP>:8765
"""
import asyncio
import json
import os
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth_db, db, games as games_mod, rooms
from .auth import router as auth_router, get_optional_user, get_current_user, init_auth
from engine import actions as engine_actions
from engine import data as engine_data
from engine import flow as engine_flow
from engine import setup as engine_setup
from engine import state as engine_state

app = FastAPI(title='《工业革命·兰开夏》联机服务器', version='1.0.0')
app.include_router(auth_router)

# 来源限制：默认 '*' 方便本机/局域网；部署到 VPS 时设环境变量 CORS_ORIGINS=https://你的域名
# （同源由服务端托管 web/dist 时不依赖 CORS；此项仅用于 ?api= 跨源调试或独立前端托管）
_cors_origins = os.environ.get('CORS_ORIGINS', '*').split(',')
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=['*'],
    allow_headers=['*'],
)

db.init_db()
init_auth()  # 账号库建表（幂等；无 DATABASE_URL 时回退本地 auth.db）

POLL_INTERVAL = 0.25      # 长轮询内部检查间隔（秒）
POLL_TIMEOUT_MAX = 30.0


# ---------------- 简易每-IP 速率限制（防刷屏/刷房，零依赖） ----------------
from collections import defaultdict, deque

_RATE = defaultdict(lambda: defaultdict(deque))  # _RATE[ip][bucket] -> 时间戳队列


def _client_ip(request: Request) -> str:
    """真实客户端 IP：优先 nginx 的 X-Real-IP / X-Forwarded-For，
    直连时退回 request.client.host（经 nginx 反代会恒为 127.0.0.1，不可用于限流）。"""
    xri = request.headers.get('x-real-ip')
    if xri:
        return xri.strip()
    xff = request.headers.get('x-forwarded-for')
    if xff:
        return xff.split(',')[0].strip()
    return request.client.host if request.client else 'unknown'


def rate_limit(request: Request, bucket: str, max_count: int, window: int):
    """窗口 window 秒内同一 IP+bucket 超过 max_count 次即返回 429。"""
    dq = _RATE[_client_ip(request)][bucket]
    now = time.time()
    while dq and dq[0] <= now - window:
        dq.popleft()
    if len(dq) >= max_count:
        raise HTTPException(429, '操作过于频繁，请稍后再试')
    dq.append(now)


# ---------------- 请求模型 ----------------

class CreateRoomReq(BaseModel):
    roomName: str = ''
    playerName: str = Field(default='玩家1', max_length=16)
    withBot: bool = False        # 机器人陪练房：机器人兼房主、永远已准备、只会跳过
    password: str = Field(default='', max_length=32)  # 非空则为带密码房间
    gameId: str = Field(default='brass', max_length=32)  # 平台游戏 id（见 /api/games）


class JoinReq(BaseModel):
    playerName: str = Field(default='玩家', max_length=16)
    password: str = Field(default='', max_length=32)


class TokenReq(BaseModel):
    token: str


class ReadyReq(TokenReq):
    ready: bool = True


class StartReq(TokenReq):
    seed: int | None = None


class ActionReq(TokenReq):
    action: dict = Field(description='行动请求体，见 schema/action.schema.json')


class CheatReq(TokenReq):
    """陪练房专用调试补给（仅 bot 房可用）。"""
    money: int = 0
    actionPoints: int = 0


# ---------------- 工具 ----------------

def _room_or_404(room_id):
    room = db.load_room(room_id)
    if not room:
        raise HTTPException(404, '房间不存在或已解散')
    return room


def _seat_or_403(room, token):
    seat = rooms.seat_of(room, token)
    if not seat:
        raise HTTPException(403, '身份无效，请重新加入房间')
    return seat


def _game_of(room):
    """从 SQLite 取对局状态。

    必须过 normalize_state：JSON 往返会把 mat 的 int 等级键变成字符串，
    不修就会让 tile_def() 查空、建造校验直接崩（见 engine/state.py 说明）。
    """
    if not room.get('gameId'):
        return None
    return engine_state.normalize_state(db.load_game(room['gameId']))


BOT_MAX_STEPS = 200


def _begin_game(room, seed=None):
    """按座位顺序建立对局并写库（座位号 ↔ engine 的 P1..P4 一一对应）。"""
    names = [s['name'] for s in room['seats']]
    game_id = rooms.new_id(8)
    st = engine_setup.create_game(names, seed=seed, game_id=game_id)
    bot_ids = rooms.bot_player_ids(room)
    for seat, p in zip(room['seats'], st['players']):
        p['name'] = seat['name']
        p['seat'] = seat['index']
        p['isBot'] = seat['playerId'] in bot_ids
    drive_bots(room, st)                  # 机器人可能是先手，先替它走完
    db.save_game(game_id, st)
    room['gameId'] = game_id
    room['status'] = 'playing'
    room['rev'] += 1
    db.save_room(room['roomId'], room)
    return st


def drive_bots(room, st):
    """轮到机器人时自动结束它的回合：有手牌就逐点「跳过」，随后结束回合。

    机器人只做跳过 —— 目的是把回合迅速交还给人类，让人类反复练每个按钮。
    """
    if not st or st.get('gameOver'):
        return st
    bot_ids = rooms.bot_player_ids(room)
    if not bot_ids:
        return st
    steps = 0
    while st['currentPlayer'] in bot_ids and not st.get('gameOver') and steps < BOT_MAX_STEPS:
        steps += 1
        # 强制拆板抵债：轮到机器人欠债时，自动拆除自己的产业板块抵债（无板块则引擎自动扣分/勾销）
        if st.get('pendingForeclose'):
            fpid = st['pendingForeclose']['pid']
            fp = engine_state.get_player(st, fpid)
            ftile = fp['industryTiles'][0] if fp.get('industryTiles') else None
            if ftile:
                engine_actions.apply_action(st, {'type': 'foreclose_tile', 'playerId': fpid, 'tileId': ftile['id']})
            else:
                # 不应发生（无板块时引擎直接走扣分，不会挂起）；兜底结束以免死循环
                engine_flow.end_turn(st)
            continue
        p = engine_state.get_player(st, st['currentPlayer'])
        if st.get('actionPoints', 0) > 0 and p['hand']:
            r = engine_actions.apply_action(st, {'type': 'autoSkip', 'playerId': p['id']})
            if not r.get('ok'):
                engine_flow.end_turn(st)
        else:
            engine_flow.end_turn(st)
    return st


def _maybe_autostart(room_id, room, token):
    """机器人房：满 2 人且全部已准备 → 立刻开局。返回可能被替换的 room。"""
    if room.get('status') != 'lobby' or not room.get('bot'):
        return room
    if not rooms.all_ready(room):
        return room
    _begin_game(room)
    return db.load_room(room_id) or room


# ---------------- 终局结算（房间置 finished + 记录登录玩家战绩） ----------------

def _record_results(room, st):
    """终局时给每个绑定了账号的座位写一条战绩（进 Neon 持久库，游客不记）。

    只改 room dict（置 resultsRecorded）与账号库，不碰对局库；
    由调用方在合适时机 db.save_room。战绩写失败只打日志，绝不影响主流程。
    """
    if room.get('resultsRecorded') or not st or not st.get('gameOver'):
        return
    room['resultsRecorded'] = True
    ranking = st.get('ranking') or []
    scores = st.get('scores') or {}
    n = len(st.get('players') or []) or len(ranking)
    game_id = room.get('gameId') or 'brass'
    for seat in room.get('seats', []):
        uid = seat.get('userId')
        pid = seat.get('playerId')
        if not uid or not pid or pid not in scores:
            continue
        try:
            rank = ranking.index(pid) + 1 if pid in ranking else n
        except ValueError:
            rank = n
        score = int((scores.get(pid) or {}).get('total') or 0)
        try:
            auth_db.add_game_result(uid, n, rank, score, game_id=game_id)
        except Exception as e:   # 账号库挂了不影响对局收尾
            print('[stats] 战绩写入失败 user=%s: %r' % (uid, e))


def _finish_game(room, st):
    """对局终局统一入口：房间置 finished + 记战绩 + 落库（幂等）。"""
    if room['status'] == 'finished':
        return
    room['status'] = 'finished'
    room['rev'] += 1
    _record_results(room, st)
    db.save_room(room['roomId'], room)


def local_ips():
    """列出本机可被局域网访问的 IPv4 地址，便于打印邀请地址。"""
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith('127.'):
                ips.add(ip)
    except OSError:
        pass
    return sorted(ips)


# ---------------- 基础 ----------------

@app.get('/api/health')
def health():
    return {'status': 'ok', 'engine': 'ready', 'lan': local_ips()}


@app.get('/api/games')
def list_games():
    """平台游戏清单（平台壳唯一数据源；新增游戏只改 data/games.json）。"""
    return {'games': games_mod.list_games()}


@app.get('/api/static-data')
def static_data():
    """地图、板块、收入轨等静态规则数据，前端启动时取一次。"""
    return {
        'locations': engine_data.LOCATIONS,
        'industryTiles': engine_data.INDUSTRY_TILES,
        'cards': engine_data.CARDS,
        'incomeTrack': engine_data.INCOME_TRACK,
    }


# ---------------- 玩家留言（公开意见箱，无需登录） ----------------

class FeedbackReq(BaseModel):
    text: str
    contact: str = ''


# server/data/feedback.log（JSONL：每行一条 {ts,ip,text,contact}）
FEEDBACK_PATH = Path(__file__).resolve().parent.parent / 'data' / 'feedback.log'


@app.post('/api/feedback')
def submit_feedback(req: FeedbackReq, request: Request):
    """玩家直接提意见：追加到本地日志文件，供运营者 SSH 后读取。无鉴权、无回复能力。"""
    rate_limit(request, 'feedback', 5, 60)
    text = (req.text or '').strip()
    if not text:
        raise HTTPException(400, '留言内容不能为空')
    if len(text) > 2000:
        raise HTTPException(400, '留言过长（上限 2000 字）')
    contact = (req.contact or '').strip()[:200]
    ip = request.client.host if request.client else 'unknown'
    FEEDBACK_PATH.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({
        'ts': datetime.now(timezone.utc).isoformat(),
        'ip': ip,
        'text': text,
        'contact': contact,
    }, ensure_ascii=False)
    with open(FEEDBACK_PATH, 'a', encoding='utf-8') as f:
        f.write(line + '\n')
    return {'ok': True}


# ---------------- 大厅 / 房间 ----------------

@app.get('/api/rooms')
def list_rooms():
    rooms.gc_rooms()   # 列出前清理掉线/空房间，大厅永不显示僵尸房
    return {'rooms': [rooms.public_room(r) for r in db.list_rooms()]}


@app.post('/api/rooms')
def create_room(req: CreateRoomReq, request: Request, current_user: dict = Depends(get_optional_user)):
    rate_limit(request, 'rooms', 10, 60)
    g = games_mod.get_game(req.gameId)
    if not g:
        raise HTTPException(400, '未知游戏')
    if g['status'] != 'available':
        raise HTTPException(400, '该游戏暂未开放')
    room, token = rooms.create_room(req.roomName, req.playerName, with_bot=req.withBot,
                                    password=req.password, game_id=req.gameId)
    # 登录用户建房即把账号绑到房主座位（游客留空，保留匿名游玩）
    if current_user:
        room['seats'][0]['userId'] = current_user['id']
        db.save_room(room['roomId'], room)
    return {'token': token, 'room': rooms.room_view(room, token)}


@app.post('/api/rooms/{room_id}/join')
def join_room(room_id: str, req: JoinReq, current_user: dict = Depends(get_optional_user)):
    # 同账号同房间防重复占座（房间 + user_id 唯一）
    if current_user:
        existing = db.load_room(room_id)
        if existing:
            for s in existing.get('seats', []):
                if s.get('userId') == current_user['id']:
                    raise HTTPException(400, '你已在该房间')
    room, token, err = rooms.join_room(room_id, req.playerName, req.password)
    if err:
        raise HTTPException(400, err)
    # 登录用户入房即把账号绑到新座位
    if current_user:
        room['seats'][-1]['userId'] = current_user['id']
        db.save_room(room['roomId'], room)
    return {'token': token, 'room': rooms.room_view(room, token)}


@app.post('/api/rooms/{room_id}/leave')
def leave_room(room_id: str, req: TokenReq):
    rooms.leave_room(room_id, req.token)
    return {'ok': True}


@app.post('/api/rooms/{room_id}/ready')
def ready(room_id: str, req: ReadyReq):
    room = rooms.set_ready(room_id, req.token, req.ready)
    if not room:
        raise HTTPException(404, '房间不存在')
    room = _maybe_autostart(room_id, room, req.token)
    seat = rooms.seat_of(room, req.token)
    st = _game_of(room) if room.get('gameId') else None
    return {'room': rooms.room_view(room, req.token),
            'state': rooms.view_for(st, seat['playerId']) if (st and seat) else None}


@app.post('/api/rooms/{room_id}/start')
def start_game(room_id: str, req: StartReq):
    """房主开局：按座位顺序建立对局，座位号与 engine 的 P1..P4 一一对应。"""
    room = _room_or_404(room_id)
    _seat_or_403(room, req.token)
    # 机器人房里房主是机器人，其 token 不外泄，故改由任一人类座位发起
    if room['hostToken'] != req.token and not room.get('bot'):
        raise HTTPException(403, '只有房主可以开始游戏')
    if room['status'] == 'playing':
        raise HTTPException(400, '对局已在进行中')
    if len(room['seats']) < 2:
        raise HTTPException(400, '至少需要 2 名玩家')

    st = _begin_game(room, seed=req.seed)
    seat = rooms.seat_of(room, req.token)
    return {'room': rooms.room_view(room, req.token),
            'state': rooms.view_for(st, seat['playerId'])}


@app.post('/api/rooms/{room_id}/restart')
def restart(room_id: str, req: StartReq):
    """房主重开：回到大厅，保留座位。"""
    room = _room_or_404(room_id)
    if room['hostToken'] != req.token and not (room.get('bot') and rooms.seat_of(room, req.token)):
        raise HTTPException(403, '只有房主可以重开')
    room['status'] = 'lobby'
    room['gameId'] = None
    room['resultsRecorded'] = False   # 重开新局后战绩要能重新记录
    room['rev'] += 1
    db.save_room(room_id, room)
    return {'room': rooms.room_view(room, req.token)}


# ---------------- 账号 ↔ 房间绑定（登录系统接入点） ----------------

@app.post('/api/auth/bind-room')
def bind_room(request: Request, body: dict):
    """游客中途登录：把当前房间座位绑定到登录账号（用于「先玩后登录」）。"""
    user = get_current_user(request)
    room_id = body.get('roomId')
    room_token = body.get('roomToken')
    room = db.load_room(room_id) if room_id else None
    if not room:
        raise HTTPException(404, '房间不存在')
    seat = rooms.seat_of(room, room_token)
    if not seat:
        raise HTTPException(403, '房间身份无效')
    seat['userId'] = user['id']
    room['rev'] += 1
    db.save_room(room['roomId'], room)
    return {'ok': True}


@app.post('/api/auth/recover-room')
def recover_room(request: Request, body: dict):
    """凭登录 token 找回房间 token：登录用户若已绑定某房间座位，返回其房令牌（刷新不丢房）。

    前端把 roomToken 存本地即可避免重连问题；此接口用于本地存储被清空后的兜底恢复。
    """
    user = get_current_user(request)
    room_id = body.get('roomId')
    room = db.load_room(room_id) if room_id else None
    if not room:
        raise HTTPException(404, '房间不存在')
    for s in room.get('seats', []):
        if s.get('userId') == user['id']:
            return {'token': s['token'], 'room': rooms.room_view(room, s['token'])}
    raise HTTPException(404, '你当前不在该房间')


# ---------------- 观战（登录用户只读进房，不占座位） ----------------

class SpectateReq(BaseModel):
    password: str = Field(default='', max_length=32)


@app.post('/api/rooms/{room_id}/spectate')
def spectate(room_id: str, req: SpectateReq, request: Request):
    """观众进房：必须登录；密码房同样校验密码；同账号幂等（刷新重连复用原 token）。"""
    rate_limit(request, 'spectate', 10, 60)
    user = get_current_user(request)
    room, token, err = rooms.spectate_room(room_id, user, req.password)
    if err:
        raise HTTPException(400, err)
    return {'token': token, 'room': rooms.room_view(room, token)}


@app.post('/api/rooms/{room_id}/spectate/leave')
def spectate_leave(room_id: str, req: TokenReq):
    rooms.leave_spectate(room_id, req.token)
    return {'ok': True}


# ---------------- 房间聊天（玩家 + 观众共用） ----------------

class ChatReq(TokenReq):
    text: str = Field(default='', max_length=rooms.CHAT_TEXT_MAX)


@app.post('/api/rooms/{room_id}/chat')
def chat(room_id: str, req: ChatReq, request: Request):
    """发言：座位 token → 玩家身份（进房名）；观战 token → 观众身份（账号昵称，带【观战】标识）。"""
    rate_limit(request, 'chat', 8, 10)
    room = _room_or_404(room_id)
    seat = rooms.seat_of(room, req.token)
    if seat:
        name, role = seat['name'], 'player'
    else:
        sp = rooms.spectator_of(room, req.token)
        if not sp:
            raise HTTPException(403, '身份无效，请重新加入房间')
        name, role = sp['name'], 'spectator'
    text = (req.text or '').strip()
    if not text:
        raise HTTPException(400, '消息不能为空')
    room = rooms.add_chat(room_id, name, role, text)
    return {'ok': True, 'rev': room['rev']}


# ---------------- 状态同步（长轮询） ----------------

@app.get('/api/rooms/{room_id}/state')
async def room_state(room_id: str, token: str = Query(...), since: str = Query(''),
                     wait: float = Query(0.0)):
    """取房间 + 对局视角状态。

    传 since=上次返回的 rev 且 wait>0 时进入长轮询：状态未变则挂起，最多 wait 秒。
    座位 token → 本人玩家视角；观战 token → 全公开只读视角（所有手牌仅见数量与背面、无合法着法）。
    """
    room = _room_or_404(room_id)
    seat = rooms.seat_of(room, token)
    if seat:
        rooms.touch(room_id, token)
        player_id = seat['playerId']
    elif rooms.spectator_of(room, token):
        rooms.touch_spectator(room_id, token)
        player_id = None                      # view_for 对 None 隐藏所有手牌/着法
    else:
        raise HTTPException(403, '身份无效，请重新加入房间')

    deadline = time.time() + min(max(wait, 0.0), POLL_TIMEOUT_MAX)
    while True:
        room = db.load_room(room_id)
        if not room:
            raise HTTPException(404, '房间已解散')
        st = _game_of(room)
        rev = rooms.rev_of(room, st)
        if rev != since or time.time() >= deadline:
            if player_id is not None:
                seat = rooms.seat_of(room, token) or seat
                player_id = seat['playerId']
            return {'rev': rev, 'changed': rev != since,
                    'room': rooms.room_view(room, token),
                    'state': rooms.view_for(st, player_id) if st else None}
        await asyncio.sleep(POLL_INTERVAL)


# ---------------- 行动 ----------------

@app.post('/api/rooms/{room_id}/action')
def submit_action(room_id: str, req: ActionReq):
    """提交行动：服务端权威校验 + 执行；失败时状态零改动。"""
    room = _room_or_404(room_id)
    seat = _seat_or_403(room, req.token)
    st = _game_of(room)
    if not st:
        raise HTTPException(400, '对局尚未开始')

    action = dict(req.action or {})
    action['playerId'] = seat['playerId']        # 身份由服务端注入，客户端不可伪造
    result = engine_actions.apply_action(st, action)
    if result['ok']:
        drive_bots(room, st)                 # 行动可能推进到机器人回合，替它走完再落库
        db.save_game(room['gameId'], st)
        if st.get('gameOver'):
            _finish_game(room, st)           # 终局：置 finished + 记录登录玩家战绩
    return {'result': result, 'rev': rooms.rev_of(room, st),
            'state': rooms.view_for(st, seat['playerId'])}


@app.post('/api/rooms/{room_id}/end-turn')
def end_turn(room_id: str, req: TokenReq):
    """无牌可打 / 主动收尾时推进回合（仅当前玩家可调用）。"""
    room = _room_or_404(room_id)
    seat = _seat_or_403(room, req.token)
    st = _game_of(room)
    if not st:
        raise HTTPException(400, '对局尚未开始')
    if st['currentPlayer'] != seat['playerId']:
        raise HTTPException(403, '当前不是你的回合')
    if st.get('gameOver'):
        raise HTTPException(400, '本局已结束')
    engine_flow.end_turn(st)
    drive_bots(room, st)
    db.save_game(room['gameId'], st)
    if st.get('gameOver'):
        _finish_game(room, st)               # 终局：置 finished + 记录登录玩家战绩
    return {'rev': rooms.rev_of(room, st), 'state': rooms.view_for(st, seat['playerId'])}


@app.post('/api/rooms/{room_id}/cheat')
def cheat(room_id: str, req: CheatReq):
    """陪练房调试补给：给自己加钱 / 加行动点，用来快速凑齐各行动的前置条件。

    仅机器人陪练房开放；正式房间一律 403。
    """
    room = _room_or_404(room_id)
    seat = _seat_or_403(room, req.token)
    if not room.get('bot'):
        raise HTTPException(403, '作弊补给仅在机器人陪练房可用')
    st = _game_of(room)
    if not st:
        raise HTTPException(400, '对局尚未开始')
    p = engine_state.get_player(st, seat['playerId'])
    if req.money:
        p['money'] = max(0, p['money'] + int(req.money))
    if req.actionPoints:
        st['actionPoints'] = max(0, st.get('actionPoints', 0) + int(req.actionPoints))
    st['version'] += 1
    engine_flow.recompute(st)
    engine_flow.log(st, '[陪练房] %s 补给：金钱 %+d，行动点 %+d'
                    % (p['id'], int(req.money), int(req.actionPoints)))
    db.save_game(room['gameId'], st)
    return {'rev': rooms.rev_of(room, st), 'state': rooms.view_for(st, seat['playerId'])}


@app.get('/api/rooms/{room_id}/preview')
def preview(room_id: str, token: str = Query(...), location: str = Query(...),
            coal: int = Query(0), iron: int = Query(0)):
    """成本预览（PRD 14.3 S4「预览消耗」）：给出免费煤源与需从市场补买的花费。"""
    room = _room_or_404(room_id)
    _seat_or_403(room, token)
    st = _game_of(room)
    if not st:
        raise HTTPException(400, '对局尚未开始')
    from engine import mechanics as M
    bill = M.resource_bill(st, location, coal, iron)
    srcs = [{'tileId': t['id'], 'location': t['location'], 'owner': t['owner'],
             'remaining': t['boardResources'], 'distance': d}
            for t, d in M.coal_sources(st, location)]
    return {'bill': bill, 'coalSources': srcs,
            'ironSources': [{'tileId': t['id'], 'location': t['location'],
                             'owner': t['owner'], 'remaining': t['boardResources']}
                            for t in M.iron_sources(st)]}


# ---------------- 静态前端（构建产物存在时由本服务托管，免跨域） ----------------

WEB_DIST = os.path.join(PROJECT_ROOT, 'web', 'dist')
if os.path.isdir(WEB_DIST):
    app.mount('/assets', StaticFiles(directory=os.path.join(WEB_DIST, 'assets')), name='assets')

    @app.get('/')
    def index():
        return FileResponse(os.path.join(WEB_DIST, 'index.html'))

    @app.get('/{path:path}')
    def spa(path: str):
        target = os.path.join(WEB_DIST, path)
        if os.path.isfile(target):
            return FileResponse(target)
        return FileResponse(os.path.join(WEB_DIST, 'index.html'))
else:
    @app.get('/')
    def index_dev():
        return {'message': '前端尚未构建。开发模式请另开 Vite（npm run dev -- --host），'
                           '或先在 web/ 执行 npm run build 后由本服务托管。',
                'lan': local_ips()}
