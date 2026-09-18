# -*- coding: utf-8 -*-
"""联机房间：座位、身份令牌、视角过滤、修订号。

设计要点（对齐 PRD 12.1「服务器权威」）：
- 客户端只持有 token，服务器据此解析座位与 playerId，行动方无法伪造他人身份。
- 下发状态经 `view_for` 过滤：他人手牌、抽牌堆内容、远方市场牌库、撤回栈一律不外泄。
- 修订号 `rev` = 房间修订.对局版本，供客户端长轮询做「有变化才返回」。
"""
import secrets
import threading
import time

from . import auth_db, db

COLORS = ['red', 'yellow', 'white', 'purple']
MAX_SEATS = 4
MAX_SPECTATORS = 20       # 单房观众上限：长轮询每观众≈1 连接+每次变更 1 份视角 JSON，免费档稳载 ~100 并发
MAX_CHAT_MESSAGES = 100   # 房间内聊天保留最近 N 条（ring buffer）
CHAT_TEXT_MAX = 200       # 单条聊天字数上限
STALE_SECS = 90  # 座位 lastSeen 超过此时长判定为掉线离开
_lock = threading.RLock()


def new_id(n=6):
    return secrets.token_hex(n // 2).upper()


# ---------------- 房间生命周期 ----------------

BOT_NAME = '机器人'


def create_room(room_name, host_name, with_bot=False, password=''):
    """创建房间。

    with_bot=True 时开「机器人陪练房」：0 号座位是服务端机器人并兼任房主，
    它永远处于已准备状态、只会做「跳过」，人类点准备即满员自动开局。
    机器人的 token 只存在服务端，绝不下发。
    password 非空则为带密码房间，进房须匹配；空字符串表示无密码。
    """
    room_id = new_id(6)
    token = secrets.token_urlsafe(16)
    pw = (password or '').strip()[:32]
    if with_bot:
        bot_token = secrets.token_urlsafe(16)
        seats = [_seat(0, bot_token, BOT_NAME, is_bot=True),
                 _seat(1, token, host_name)]
        host_token = bot_token
        default_name = '%s 的陪练房' % host_name
    else:
        seats = [_seat(0, token, host_name)]
        host_token = token
        default_name = '%s 的房间' % host_name
    room = {
        'roomId': room_id,
        'name': room_name or default_name,
        'status': 'lobby',            # lobby / playing / finished
        'hostToken': host_token,
        'bot': bool(with_bot),
        'gameId': None,
        'rev': 1,
        'createdAt': time.time(),
        'password': pw,               # 空字符串 = 无密码
        'seats': seats,
    }
    db.save_room(room_id, room)
    return room, token


def _seat(index, token, name, is_bot=False):
    return {'index': index, 'token': token, 'name': name or ('玩家%d' % (index + 1)),
            'color': COLORS[index], 'playerId': 'P%d' % (index + 1),
            'ready': True if is_bot else index == 0,
            'isBot': bool(is_bot), 'lastSeen': time.time()}


def bot_seats(room):
    return [s for s in room.get('seats', []) if s.get('isBot')]


def bot_player_ids(room):
    return {s['playerId'] for s in bot_seats(room)}


def all_ready(room):
    seats = room.get('seats', [])
    return len(seats) >= 2 and all(s.get('ready') for s in seats)


def join_room(room_id, name, password=''):
    """返回 (room, token, err)；失败时前两项为 None。"""
    with _lock:
        room = db.load_room(room_id)
        if not room:
            return None, None, '房间不存在或已解散'
        if room.get('password') and password != room['password']:
            return None, None, '房间密码错误'
        if room['status'] != 'lobby':
            return None, None, '对局已开始，无法加入'
        if len(room['seats']) >= MAX_SEATS:
            return None, None, '房间已满（最多 4 人）'
        token = secrets.token_urlsafe(16)
        room['seats'].append(_seat(len(room['seats']), token, name))
        room['rev'] += 1
        db.save_room(room_id, room)
        return room, token, None


def leave_room(room_id, token):
    with _lock:
        room = db.load_room(room_id)
        if not room:
            return None
        seats = [s for s in room['seats'] if s['token'] != token]
        if len(seats) == len(room['seats']):
            return room
        # 只剩机器人（或空）时房间没有存在意义，直接解散
        if not seats or all(s.get('isBot') for s in seats):
            db.delete_room(room_id)
            if room.get('gameId'):
                db.delete_game(room['gameId'])
            return None
        # 重排座位号与颜色，房主离开则顺位继任
        for i, s in enumerate(seats):
            s['index'], s['color'], s['playerId'] = i, COLORS[i], 'P%d' % (i + 1)
        if room['hostToken'] == token:
            room['hostToken'] = seats[0]['token']
        room['seats'] = seats
        room['rev'] += 1
        db.save_room(room_id, room)
        return room


def gc_rooms():
    """清理僵尸房间（列出房间时调用）：
    - lobby：踢出掉线座位，若无人则删房间；
    - playing/finished：仅当全员掉线才删房间+对局；否则保留掉线者座位
      （其 token 仍可用于刷新重连，避免破坏引擎 P1..P4 映射）。
    """
    with _lock:
        for room in db.list_rooms():
            room_id = room['roomId']
            gc_spectators(room)   # 掉线观众随时清（房间被删时观众随房间一起消失）
            seats = room.get('seats', [])
            alive = [s for s in seats
                     if s.get('isBot') or time.time() - s.get('lastSeen', 0) < STALE_SECS]
            if len(alive) == len(seats):
                continue  # 无掉线者，跳过
            if not alive or all(s.get('isBot') for s in alive):
                # 全员掉线 -> 房间废弃，连同对局一起清
                db.delete_room(room_id)
                if room.get('gameId'):
                    db.delete_game(room['gameId'])
                continue
            if room['status'] == 'lobby':
                for i, s in enumerate(alive):
                    s['index'], s['color'], s['playerId'] = i, COLORS[i], 'P%d' % (i + 1)
                if room['hostToken'] not in {s['token'] for s in alive}:
                    room['hostToken'] = alive[0]['token']
                room['seats'] = alive
                room['rev'] += 1
                db.save_room(room_id, room)
            # playing/finished：保留掉线座位不动，重连靠 token


def set_ready(room_id, token, ready):
    with _lock:
        room = db.load_room(room_id)
        if not room:
            return None
        for s in room['seats']:
            if s['token'] == token:
                s['ready'] = bool(ready)
        room['rev'] += 1
        db.save_room(room_id, room)
        return room


def touch(room_id, token):
    """记录心跳，供大厅显示在线状态。"""
    with _lock:
        room = db.load_room(room_id)
        if not room:
            return
        changed = False
        for s in room['seats']:
            if s['token'] == token and time.time() - s.get('lastSeen', 0) > 5:
                s['lastSeen'] = time.time()
                changed = True
        if changed:
            db.save_room(room_id, room)


def seat_of(room, token):
    for s in room.get('seats', []):
        if s['token'] == token:
            return s
    return None


# ---------------- 观战（不占座位，只读视角，必须登录） ----------------

def spectate_room(room_id, user, password=''):
    """观众进房：返回 (room, token, err)；失败时前两项为 None。

    观众不占座位（不破坏引擎 P1..P4 映射），身份 = 登录账号昵称。
    同账号重复观战幂等返回原 token（刷新/重连不重复占观众席）。
    """
    with _lock:
        room = db.load_room(room_id)
        if not room:
            return None, None, '房间不存在或已解散'
        for s in room.get('seats', []):
            if s.get('userId') == user['id']:
                return None, None, '你已在该房间对局中'
        for sp in room.get('spectators', []):
            if sp.get('userId') == user['id']:
                return room, sp['token'], None     # 幂等重连
        if room.get('password') and password != room['password']:
            return None, None, '房间密码错误'
        spectators = room.setdefault('spectators', [])
        if len(spectators) >= MAX_SPECTATORS:
            return None, None, '观众席已满（最多 %d 人）' % MAX_SPECTATORS
        token = secrets.token_urlsafe(16)
        spectators.append({'token': token, 'userId': user['id'],
                           'name': (user.get('displayName') or user.get('username') or '观众')[:16],
                           'lastSeen': time.time()})
        room['rev'] += 1
        db.save_room(room_id, room)
        return room, token, None


def spectator_of(room, token):
    for sp in room.get('spectators', []):
        if sp['token'] == token:
            return sp
    return None


def leave_spectate(room_id, token):
    with _lock:
        room = db.load_room(room_id)
        if not room:
            return None
        before = len(room.get('spectators', []))
        room['spectators'] = [sp for sp in room.get('spectators', []) if sp['token'] != token]
        if len(room['spectators']) != before:
            room['rev'] += 1
            db.save_room(room_id, room)
        return room


def touch_spectator(room_id, token):
    """观众心跳（不改 rev，不触发广播）。"""
    with _lock:
        room = db.load_room(room_id)
        if not room:
            return
        changed = False
        for sp in room.get('spectators', []):
            if sp['token'] == token and time.time() - sp.get('lastSeen', 0) > 5:
                sp['lastSeen'] = time.time()
                changed = True
        if changed:
            db.save_room(room_id, room)


def gc_spectators(room):
    """清掉线观众（座位仍按原 gc_rooms 规则处理）。调用方须已持有房间 dict。"""
    specs = room.get('spectators', [])
    alive = [sp for sp in specs if time.time() - sp.get('lastSeen', 0) < STALE_SECS]
    if len(alive) != len(specs):
        room['spectators'] = alive
        room['rev'] += 1
        db.save_room(room['roomId'], room)


# ---------------- 房间聊天（玩家 + 观众共用；大厅等待阶段也可用） ----------------

def add_chat(room_id, name, role, text):
    """追加一条聊天（role: player/spectator），rev+1 触发长轮询广播给全房间。"""
    with _lock:
        room = db.load_room(room_id)
        if not room:
            return None
        msgs = room.setdefault('chatMsgs', [])
        msgs.append({'from': (name or '玩家')[:16], 'role': role,
                     'text': text[:CHAT_TEXT_MAX], 'ts': time.time()})
        del msgs[:-MAX_CHAT_MESSAGES]
        room['rev'] += 1
        db.save_room(room_id, room)
        return room


# ---------------- 座位头像（登录玩家带自己的账号头像进对局） ----------------

_AVATAR_TTL = 60.0                 # 头像缓存秒数：长轮询高频调 room_view，不能每次都打账号库
_AVATAR_CACHE = {}                 # user_id -> (avatar, 过期时间戳)


def seat_avatar(seat):
    """座位头像：绑定了账号则取账号头像；游客/机器人返回 ''（前端自行兜底）。

    账号库（Neon）挂掉时绝不影响房间视图——异常吞掉并退回缓存旧值。
    """
    uid = seat.get('userId')
    if not uid:
        return ''
    now = time.time()
    hit = _AVATAR_CACHE.get(uid)
    if hit and hit[1] > now:
        return hit[0]
    try:
        u = auth_db.get_user_public(uid)
        av = (u or {}).get('avatar') or ''
    except Exception:
        av = hit[0] if hit else ''   # 查询失败退回旧值（头像非关键数据）
    _AVATAR_CACHE[uid] = (av, now + _AVATAR_TTL)
    return av


def rev_of(room, state):
    return '%d.%d' % (room.get('rev', 0), (state or {}).get('version', 0))


def public_room(room):
    """大厅列表用：不含任何 token。"""
    return {
        'roomId': room['roomId'], 'name': room['name'], 'status': room['status'],
        'bot': bool(room.get('bot')),
        'hasPassword': bool(room.get('password')),
        'players': [{'name': s['name'], 'color': s['color'], 'ready': s['ready'],
                     'isBot': bool(s.get('isBot')), 'avatar': seat_avatar(s),
                     'online': bool(s.get('isBot')) or time.time() - s.get('lastSeen', 0) < 30}
                    for s in room['seats']],
        'seatCount': len(room['seats']), 'maxSeats': MAX_SEATS,
        'spectatorCount': len(room.get('spectators', [])),
        'createdAt': room.get('createdAt'),
    }


def room_view(room, token):
    """房间详情（自己的座位标记出来，其余人不含 token）。"""
    me = seat_of(room, token)
    return {
        'roomId': room['roomId'], 'name': room['name'], 'status': room['status'],
        'gameId': room.get('gameId'), 'rev': room.get('rev', 0),
        'bot': bool(room.get('bot')),
        # 机器人房里机器人兼任房主，但开局/重开的操作权交给人类
        'isHost': bool(me and (room['hostToken'] == token or room.get('bot'))),
        'mySeat': me['index'] if me else None,
        'myPlayerId': me['playerId'] if me else None,
        'seats': [{'index': s['index'], 'name': s['name'], 'color': s['color'],
                   'playerId': s['playerId'], 'ready': s['ready'],
                   'isBot': bool(s.get('isBot')), 'avatar': seat_avatar(s),
                   'online': bool(s.get('isBot')) or time.time() - s.get('lastSeen', 0) < 30,
                   'isMe': s['token'] == token}
                  for s in room['seats']],
        'maxSeats': MAX_SEATS,
        # 观众席（头像走同一 TTL 缓存；观众也是登录用户）
        'spectators': [{'name': sp['name'], 'avatar': seat_avatar(sp),
                        'online': time.time() - sp.get('lastSeen', 0) < 30,
                        'isMe': sp['token'] == token}
                       for sp in room.get('spectators', [])],
        'iAmSpectator': bool(me is None and spectator_of(room, token)),
        'maxSpectators': MAX_SPECTATORS,
        # 房间聊天（玩家+观众共用，ring buffer 由 add_chat 维护）
        'chatMsgs': [{'from': m['from'], 'role': m['role'], 'text': m['text'], 'ts': m['ts']}
                     for m in room.get('chatMsgs', [])],
    }


# ---------------- 视角过滤 ----------------

_HIDDEN_TOP = ('undoStack', 'drawPile')


def view_for(state, player_id):
    """把权威状态裁剪成某个玩家可见的视角。

    隐藏：他人手牌明细、抽牌堆内容、远方市场牌库剩余牌面、撤回栈。
    仅当前行动玩家才下发按钮态与合法落点（其余人拿到空集，避免提前窥探）。
    """
    if state is None:
        return None
    view = {k: v for k, v in state.items() if k not in _HIDDEN_TOP}
    players = []
    for p in state['players']:
        q = dict(p)
        q['handCount'] = len(p['hand'])
        if p['id'] != player_id:
            q['hand'] = []
        players.append(q)
    view['players'] = players
    view['deckRemaining'] = len(state.get('drawPile', []))
    view['discardCount'] = len(state.get('discardPile', []))
    rm = state.get('remoteMarketDeck') or {}
    view['remoteMarketDeck'] = {'remaining': len(rm.get('cards', [])), 'drawn': list(rm.get('drawn', []))}
    view['remoteCottonTrack'] = state.get('remoteCottonTrack', 0)
    view['undoAvailable'] = bool(state.get('undoStack')) and state.get('currentPlayer') == player_id
    view['viewerId'] = player_id
    view['isMyTurn'] = state.get('currentPlayer') == player_id
    if state.get('currentPlayer') != player_id:
        view['buttonEnabled'] = {k: False for k in (state.get('buttonEnabled') or {})}
        view['selectableCards'] = []
        view['legalBuilds'] = []
        view['legalDoubleBuilds'] = []
        view['legalLinks'] = []
        view['sellables'] = []
    return view
