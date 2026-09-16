# -*- coding: utf-8 -*-
"""账号与登录接口（独立于对局）。

路由前缀 /api/auth：
  POST /register            注册（含安全问答），成功自动登录
  POST /login               登录
  POST /logout              登出（撤销当前 token）
  GET  /me                  取当前登录态（未登录返回 {authenticated:false}）
  PUT  /me                  改昵称 / 头像（仅自己）
  POST /change-password    改密码（验旧设新 + 清全部会话）
  POST /delete-account      注销账号（密码确认 + 级联清会话 + 正玩对局座位置空）
  POST /recover/start       取安全问答题目（不暴露用户名是否存在）
  POST /recover/verify      答对即重置密码并自动登录

安全约定：
  - 密码 / 安全问答答案统一 bcrypt 哈希，绝不明文存储。
  - 登录 / 找回失败时统一 401，不区分「用户不存在」与「密码错」，防用户名枚举。
  - 所有写接口按 IP 限流。
  - 登录 token = 随机串存库（DB 会话），不依赖 JWT_SECRET；JWT_SECRET 保留为兼容占位。
  - token 滑动续期（见 auth_db.get_session_user），玩家长时间在线不会被踢。
"""
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import auth_db, db

router = APIRouter(prefix='/api/auth', tags=['auth'])

# 登录 token 有效期（秒），与 AUTH_TOKEN_TTL 一致
import os
try:
    AUTH_TTL = int(os.environ.get('AUTH_TOKEN_TTL', '2592000'))
except ValueError:
    AUTH_TTL = 2592000

# ---------------- 固定安全问答（注册必填 3 题，找回须全对） ----------------
SECURITY_QUESTIONS = [
    {'qid': 'q_father', 'question': '你父亲的名字是？'},
    {'qid': 'q_mother', 'question': '你母亲的名字是？'},
    {'qid': 'q_school', 'question': '你就读的第一所小学叫什么？'},
]
_KNOWN_QIDS = {q['qid'] for q in SECURITY_QUESTIONS}


# ---------------- 限流（与 main.py 同源思路，但独立 bucket，避免循环依赖） ----------------
_RATE = defaultdict(lambda: defaultdict(deque))


def _client_ip(request: Request) -> str:
    xri = request.headers.get('x-real-ip')
    if xri:
        return xri.strip()
    xff = request.headers.get('x-forwarded-for')
    if xff:
        return xff.split(',')[0].strip()
    return request.client.host if request.client else 'unknown'


def rate_limit(request: Request, bucket: str, max_count: int, window: int):
    dq = _RATE[_client_ip(request)][bucket]
    now = time.time()
    while dq and dq[0] <= now - window:
        dq.popleft()
    if len(dq) >= max_count:
        raise HTTPException(429, '操作过于频繁，请稍后再试')
    dq.append(now)


# ---------------- 密码 / 答案哈希 ----------------

def _hash(secret: str) -> str:
    return bcrypt.hashpw(secret.encode('utf-8'), bcrypt.gensalt(rounds=12)).decode('utf-8')


def _check(hash_str: str, secret: str) -> bool:
    try:
        return bcrypt.checkpw(secret.encode('utf-8'), hash_str.encode('utf-8'))
    except (ValueError, TypeError):
        return False


# ---------------- 请求模型 ----------------

class AnswerReq(BaseModel):
    qid: str
    answer: str


class RegisterReq(BaseModel):
    username: str
    password: str
    displayName: str = ''
    avatar: str = ''
    answers: list[AnswerReq]


class LoginReq(BaseModel):
    username: str
    password: str


class ChangePasswordReq(BaseModel):
    oldPassword: str
    newPassword: str


class DeleteAccountReq(BaseModel):
    password: str


class RecoverStartReq(BaseModel):
    username: str = ''   # 仅用于日志/便利，题目固定不依赖用户名


class RecoverVerifyReq(BaseModel):
    username: str
    answers: list[AnswerReq]
    newPassword: str


# ---------------- 校验 ----------------

import re

_USER_RE = re.compile(r'^[\w\u4e00-\u9fff]{3,7}$')       # 3-7 位：字母/数字/下划线/中文
_PW_RE = re.compile(r'^\S{6,11}$')                        # 6-11 位：不含空白字符


def _valid_user(s):
    return bool(_USER_RE.match(s or ''))


def _valid_pw(s):
    return bool(_PW_RE.match(s or ''))


# ---------------- 登录依赖（供 main.py 房间绑定复用） ----------------

def get_optional_user(request: Request):
    """读 Bearer token → 查会话 → 用户 dict 或 None（不抛异常，游客可继续）。"""
    h = request.headers.get('authorization') or ''
    if not h.lower().startswith('bearer '):
        return None
    tok = h[7:].strip()
    return auth_db.get_session_user(tok)


def get_current_user(request: Request):
    """强制登录：未登录 / token 失效 → 401。"""
    user = get_optional_user(request)
    if not user:
        raise HTTPException(401, '请先登录')
    return user


# ---------------- 响应工具 ----------------

def _public_user(u):
    return {
        'id': u['id'],
        'username': u['username'],
        'displayName': u.get('displayName') or u['username'],
        'avatar': u.get('avatar') or '',
    }


def _new_session(user_id):
    tok = secrets.token_urlsafe(32)
    exp = datetime.utcnow() + timedelta(seconds=AUTH_TTL)
    auth_db.create_session(tok, user_id, exp)
    return tok


# ---------------- 路由 ----------------

@router.post('/register')
def register(req: RegisterReq, request: Request):
    rate_limit(request, 'register', 5, 60)
    uname = auth_db.normalize_username(req.username)
    if not _valid_user(uname):
        raise HTTPException(400, '用户名须为 3-7 位（字母、数字、下划线或中文）')
    if not _valid_pw(req.password):
        raise HTTPException(400, '密码须为 6-11 位（不含空格）')
    # 安全问答：必须 3 题齐全且答案非空
    if len(req.answers) != len(SECURITY_QUESTIONS):
        raise HTTPException(400, '请完整填写全部安全问题')
    ans_pairs = []
    seen = set()
    for a in req.answers:
        if a.qid not in _KNOWN_QIDS:
            raise HTTPException(400, '非法的安全问题')
        if a.qid in seen:
            raise HTTPException(400, '安全问题重复')
        seen.add(a.qid)
        ans = auth_db.normalize_answer(a.answer)
        if not ans or len(ans) > 64:
            raise HTTPException(400, '安全问答答案不能为空且不超过 64 字')
        ans_pairs.append((a.qid, _hash(ans)))
    if auth_db.get_user_by_username(uname):
        raise HTTPException(409, '用户名已被注册')
    display = (req.displayName or '').strip()[:16] or uname
    try:
        user = auth_db.create_user(uname, _hash(req.password), display, req.avatar)
    except auth_db.UsernameTaken:
        raise HTTPException(409, '用户名已被注册')
    auth_db.set_security_answers(user['id'], ans_pairs)
    tok = _new_session(user['id'])
    return {'token': tok, 'user': _public_user(user)}


@router.post('/login')
def login(req: LoginReq, request: Request):
    rate_limit(request, 'login', 8, 60)
    uname = auth_db.normalize_username(req.username)
    user = auth_db.get_user_by_username(uname)
    # 统一失败响应，防用户名枚举
    if not user or not _check(user['password_hash'], req.password):
        raise HTTPException(401, '用户名或密码错误')
    tok = _new_session(user['id'])
    return {'token': tok, 'user': _public_user(user)}


@router.post('/logout')
def logout(request: Request):
    # 前端只撤销当前 token（来自 Authorization 头）；不依赖请求体，避免无 body 时 422。
    h = request.headers.get('authorization') or ''
    if h.lower().startswith('bearer '):
        auth_db.delete_session(h[7:].strip())
    return {'ok': True}


@router.get('/me')
def me(request: Request):
    user = get_optional_user(request)
    if not user:
        return {'authenticated': False}
    return {'authenticated': True, 'user': _public_user(user)}


@router.put('/me')
def update_me(req: dict, request: Request):
    user = get_current_user(request)
    dn = (req.get('displayName') or '').strip()[:16]
    avatar = (req.get('avatar') or '').strip()[:64]
    updated = auth_db.update_user(
        user['id'],
        display_name=dn if dn else None,
        avatar=avatar if avatar is not None else None,
    )
    return {'user': _public_user(updated)}


@router.post('/change-password')
def change_password(req: ChangePasswordReq, request: Request):
    user = get_current_user(request)
    if not _valid_pw(req.newPassword):
        raise HTTPException(400, '新密码须为 6-11 位（不含空格）')
    if not _check(user['password_hash'], req.oldPassword):
        raise HTTPException(400, '原密码错误')
    auth_db.update_user(user['id'], password_hash=_hash(req.newPassword))
    # 清掉全部旧会话（其他设备被踢），为本机签发新 token 保持登录
    auth_db.delete_user_sessions(user['id'])
    tok = _new_session(user['id'])
    return {'token': tok, 'user': _public_user(user)}


@router.post('/delete-account')
def delete_account(req: DeleteAccountReq, request: Request):
    user = get_current_user(request)
    if not _check(user['password_hash'], req.password):
        raise HTTPException(400, '密码错误，无法注销')
    # 先清掉该用户在所有房间座位上的绑定（保留座位，不破坏引擎 P1..P4 映射）
    _clear_seat_user(user['id'])
    auth_db.delete_user(user['id'])
    return {'ok': True}


def _clear_seat_user(user_id):
    """遍历所有房间，把 userId == user_id 的座位置空（不移除座位）。"""
    for room in db.list_rooms():
        changed = False
        for s in room.get('seats', []):
            if s.get('userId') == user_id:
                s['userId'] = None
                changed = True
        if changed:
            db.save_room(room['roomId'], room)


@router.post('/recover/start')
def recover_start(req: RecoverStartReq, request: Request):
    rate_limit(request, 'recover', 5, 60)
    # 返回固定题目列表，不依赖用户名，避免枚举
    return {'questions': SECURITY_QUESTIONS}


@router.post('/recover/verify')
def recover_verify(req: RecoverVerifyReq, request: Request):
    rate_limit(request, 'recover', 5, 60)
    uname = auth_db.normalize_username(req.username)
    if not _valid_pw(req.newPassword):
        raise HTTPException(400, '新密码须为 6-11 位（不含空格）')
    user = auth_db.get_user_by_username(uname)
    if not user:
        raise HTTPException(401, '用户名或安全问答答案错误')
    # 收集原始答案（归一化），交由 auth_db 用 bcrypt.checkpw 校验
    pairs = []
    for a in req.answers:
        if a.qid not in _KNOWN_QIDS:
            raise HTTPException(400, '非法的安全问题')
        ans = auth_db.normalize_answer(a.answer)
        if not ans:
            raise HTTPException(400, '安全问答答案不能为空')
        pairs.append((a.qid, ans))
    if not auth_db.verify_security_answers(user['id'], pairs):
        raise HTTPException(401, '用户名或安全问答答案错误')
    auth_db.update_user(user['id'], password_hash=_hash(req.newPassword))
    auth_db.delete_user_sessions(user['id'])
    tok = _new_session(user['id'])
    return {'token': tok, 'user': _public_user(user)}


def init_auth():
    """应用启动时建表（幂等）。"""
    auth_db.init_auth_db()
