# -*- coding: utf-8 -*-
"""账号数据层（独立于对局 SQLite）。

持久库（双后端）：
  - 生产：Neon Postgres（DATABASE_URL 形如 postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require）
  - 本地自测：未设置 DATABASE_URL 时回退到 server/auth.db（SQLite）

表结构：
  users(id, username UNIQUE 归一化小写, password_hash, display_name, avatar, created_at)
  sessions(token PK, user_id FK, expires_at)
  security_answers(user_id, qid) 复合主键 → answer_hash

设计要点：
  - lazy engine：首次访问才建引擎；pool_pre_ping=True 自动剔除失效连接。
  - 自动重连：执行遇到 OperationalError 时 dispose 引擎并重建一次再重试。
  - 所有对外函数返回「纯 dict / 标量」，不向外泄露 ORM 对象。
"""
import os
import threading
from datetime import datetime, timedelta, timezone

import bcrypt

from sqlalchemy import (
    Column, Integer, String, ForeignKey, DateTime,
    select, delete, update,
)
from sqlalchemy.exc import OperationalError, IntegrityError
from sqlalchemy.orm import sessionmaker, scoped_session, declarative_base

Base = declarative_base()

DATABASE_URL = (os.environ.get('DATABASE_URL') or '').strip()
_USE_POSTGRES = DATABASE_URL.startswith('postgresql://') or DATABASE_URL.startswith('postgresql+')

# 本地回退库：server/auth.db（与对局库 lancashire.db 分开，生命周期独立）
_LOCAL_SQLITE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'auth.db'
)

_engine = None
_SessionFactory = None
_EngineLock = threading.Lock()


def _make_url():
    if _USE_POSTGRES:
        return DATABASE_URL
    return 'sqlite:///' + _LOCAL_SQLITE


def _build_engine():
    global _engine, _SessionFactory
    url = _make_url()
    connect_args = {}
    if not _USE_POSTGRES:
        # SQLite 在多线程（FastAPI 线程池）下需允许跨线程复用同一连接
        connect_args = {'check_same_thread': False}
    eng = __import__('sqlalchemy').create_engine(
        url, pool_pre_ping=True, future=True,
        connect_args=connect_args, pool_recycle=1800,
    )
    _engine = eng
    _SessionFactory = scoped_session(sessionmaker(bind=eng, future=True))
    return eng


def _get_engine():
    global _engine
    if _engine is None:
        with _EngineLock:
            if _engine is None:
                _build_engine()
    return _engine


def _reconnect():
    """连接异常后销毁旧引擎并重建（保留线程锁）。"""
    global _engine, _SessionFactory
    with _EngineLock:
        try:
            if _engine is not None:
                _engine.dispose()
        except Exception:
            pass
        _engine = None
        _SessionFactory = None
        _build_engine()


def _session():
    return _SessionFactory()


def init_auth_db():
    """建表（幂等）。首次调用时建立引擎，并打印当前账号库后端。"""
    eng = _get_engine()
    Base.metadata.create_all(eng)
    if _USE_POSTGRES:
        print('[auth] 账号库后端：Postgres（DATABASE_URL）')
    else:
        # 云平台的磁盘是临时盘，回退 SQLite 等于账号随时丢失，必须显式告警。
        print('[auth] 警告：未设置 DATABASE_URL，账号库回退到本地 SQLite -> ' + _LOCAL_SQLITE)
        print('[auth] 警告：Render 等云平台磁盘为临时盘，重启/重新部署即清空，账号会全部丢失！')
        print('[auth] 请务必在 Render 控制台配置 DATABASE_URL（Neon Postgres 连接串）。')


# ---------------- 模型 ----------------

class User(Base):
    __tablename__ = 'users'
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    display_name = Column(String(32), nullable=False, default='')
    avatar = Column(String(64), nullable=False, default='')
    created_at = Column(DateTime, nullable=False, default=lambda: datetime.utcnow())


class Session(Base):
    __tablename__ = 'sessions'
    token = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    expires_at = Column(DateTime, nullable=False)


class SecurityAnswer(Base):
    __tablename__ = 'security_answers'
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
    qid = Column(String(32), primary_key=True)
    answer_hash = Column(String(255), nullable=False)


# ---------------- 归一化工具 ----------------

def normalize_username(s):
    """登录名归一化：去首尾空白、ASCII 转小写（中文不变），用作唯一键。"""
    return (s or '').strip().lower()


def normalize_answer(s):
    """安全问答答案归一化：去首尾空白、转小写以容错（中文不变）。"""
    return (s or '').strip().lower()


# ---------------- 事务包装（自动重连） ----------------

def _run(fn):
    """执行 fn(session)；遇到连接错误自动重连重试一次。"""
    for attempt in range(2):
        sess = _session()
        try:
            return fn(sess)
        except OperationalError:
            sess.rollback()
            if attempt == 0:
                _reconnect()
                continue
            raise
        finally:
            sess.close()


# ---------------- 用户 ----------------

def get_user_by_username(username):
    un = normalize_username(username)
    if not un:
        return None
    return _run(lambda s: _user_to_dict(
        s.get(User, un) if _USE_POSTGRES else
        s.execute(select(User).where(User.username == un)).scalars().first()
    ))


def get_user_by_id(user_id):
    if not user_id:
        return None
    return _run(lambda s: _user_to_dict(
        s.get(User, user_id)
    ))


def _user_to_dict(u):
    if u is None:
        return None
    return {
        'id': u.id,
        'username': u.username,
        'password_hash': u.password_hash,
        'displayName': u.display_name,
        'avatar': u.avatar,
        'created_at': u.created_at.isoformat() if u.created_at else None,
    }


class UsernameTaken(Exception):
    pass


def create_user(username, password_hash, display_name='', avatar=''):
    un = normalize_username(username)
    rec = User(username=un, password_hash=password_hash,
               display_name=(display_name or '').strip()[:32],
               avatar=(avatar or '').strip()[:64])
    try:
        def _fn(s):
            s.add(rec)
            s.commit()
            s.refresh(rec)
            return _user_to_dict(rec)
        return _run(_fn)
    except IntegrityError:
        raise UsernameTaken('用户名已被注册')


def update_user(user_id, display_name=None, avatar=None, password_hash=None):
    """更新个人资料（仅传入的字段）。返回更新后的用户 dict。"""
    def _fn(s):
        u = s.get(User, user_id)
        if u is None:
            return None
        if display_name is not None:
            u.display_name = display_name.strip()[:32]
        if avatar is not None:
            u.avatar = avatar.strip()[:64]
        if password_hash is not None:
            u.password_hash = password_hash
        s.commit()
        return _user_to_dict(u)
    return _run(_fn)


def delete_user(user_id):
    """级联删除用户（sessions / security_answers 由外键 ON DELETE CASCADE 清理）。"""
    def _fn(s):
        s.execute(delete(SecurityAnswer).where(SecurityAnswer.user_id == user_id))
        s.execute(delete(Session).where(Session.user_id == user_id))
        s.execute(delete(User).where(User.id == user_id))
        s.commit()
        return True
    return _run(_fn)


# ---------------- 会话（登录 token） ----------------

def create_session(token, user_id, expires_at):
    def _fn(s):
        s.add(Session(token=token, user_id=user_id, expires_at=expires_at))
        s.commit()
        return True
    return _run(_fn)


def get_session_user(token, ttl_slide_days=7):
    """返回 token 对应的用户 dict；失效/不存在返回 None。

    ttl_slide_days：若剩余有效期不足该天数，自动顺延到 TTL 上限（滑动续期，
    避免玩家长时间在线（如打一局）被踢下线）。token 本身不变。
    """
    if not token:
        return None

    def _fn(s):
        now = datetime.utcnow()
        row = s.get(Session, token)
        if row is None:
            return None
        if row.expires_at <= now:
            s.delete(row)
            s.commit()
            return None
        # 滑动续期
        remaining = (row.expires_at - now).days
        if remaining < ttl_slide_days:
            row.expires_at = now + timedelta(days=_SESSION_MAX_DAYS)
            s.commit()
        return _user_to_dict(s.get(User, row.user_id))
    return _run(_fn)


def delete_session(token):
    def _fn(s):
        s.execute(delete(Session).where(Session.token == token))
        s.commit()
        return True
    return _run(_fn)


def delete_user_sessions(user_id):
    def _fn(s):
        s.execute(delete(Session).where(Session.user_id == user_id))
        s.commit()
        return True
    return _run(_fn)


def _SESSION_MAX_DAYS():
    """登录 token 有效期上限（天），取自 AUTH_TOKEN_TTL 环境变量（秒）。"""
    try:
        secs = int(os.environ.get('AUTH_TOKEN_TTL', '2592000'))
    except ValueError:
        secs = 2592000
    return max(1, secs // 86400)


# ---------------- 安全问答 ----------------

def set_security_answers(user_id, pairs):
    """pairs: [(qid, answer_hash), ...]；整体替换该用户的安全问答。"""
    def _fn(s):
        s.execute(delete(SecurityAnswer).where(SecurityAnswer.user_id == user_id))
        for qid, ah in pairs:
            s.add(SecurityAnswer(user_id=user_id, qid=qid, answer_hash=ah))
        s.commit()
        return True
    return _run(_fn)


def get_security_answers(user_id):
    """返回 {qid: answer_hash}。"""
    def _fn(s):
        rows = s.execute(
            select(SecurityAnswer.qid, SecurityAnswer.answer_hash)
            .where(SecurityAnswer.user_id == user_id)
        ).all()
        return {qid: ah for qid, ah in rows}
    return _run(_fn)


def verify_security_answers(user_id, pairs):
    """pairs: [(qid, raw_answer), ...]（原始答案，非哈希）；全部匹配才返回 True。

    注意：安全问答答案以 bcrypt 哈希存储，校验必须用 bcrypt.checkpw（不能直接比哈希串，
    因为 bcrypt 每次加盐，相同答案的哈希串也不同）。统一比较以减小时序侧信道。
    """
    stored = get_security_answers(user_id)
    if not stored:
        return False
    if len(pairs) != len(stored):
        return False
    ok = True
    for qid, raw in pairs:
        expect = stored.get(qid)
        if expect is None:
            ok = False
        if not _check_secret(expect or '', raw):
            ok = False
    return ok


def _check_secret(hash_str, secret):
    try:
        return bcrypt.checkpw(secret.encode('utf-8'), hash_str.encode('utf-8'))
    except (ValueError, TypeError):
        return False


def _constant_time_eq(a, b):
    if len(a) != len(b):
        return False
    r = 0
    for x, y in zip(a, b):
        r |= ord(x) ^ ord(y)
    return r == 0
