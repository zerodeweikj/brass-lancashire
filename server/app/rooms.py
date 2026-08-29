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

from . import db

COLORS = ['red', 'yellow', 'white', 'purple']
MAX_SEATS = 4
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


def rev_of(room, state):
    return '%d.%d' % (room.get('rev', 0), (state or {}).get('version', 0))


def public_room(room):
    """大厅列表用：不含任何 token。"""
    return {
        'roomId': room['roomId'], 'name': room['name'], 'status': room['status'],
        'bot': bool(room.get('bot')),
        'hasPassword': bool(room.get('password')),
        'players': [{'name': s['name'], 'color': s['color'], 'ready': s['ready'],
                     'isBot': bool(s.get('isBot')),
                     'online': bool(s.get('isBot')) or time.time() - s.get('lastSeen', 0) < 30}
                    for s in room['seats']],
        'seatCount': len(room['seats']), 'maxSeats': MAX_SEATS,
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
                   'isBot': bool(s.get('isBot')),
                   'online': bool(s.get('isBot')) or time.time() - s.get('lastSeen', 0) < 30,
                   'isMe': s['token'] == token}
                  for s in room['seats']],
        'maxSeats': MAX_SEATS,
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
