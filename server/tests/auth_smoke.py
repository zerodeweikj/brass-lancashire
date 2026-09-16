# -*- coding: utf-8 -*-
"""账号系统后端冒烟测试（本地 sqlite 回退）。"""
import json
import urllib.request
import urllib.error

BASE = 'http://127.0.0.1:8799'


def call(method, path, body=None, token=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode())
        except Exception:
            body = None
        return e.code, body


def show(label, res):
    print(f"[{label}] {res[0]} {json.dumps(res[1], ensure_ascii=False)[:160]}")


ok = True
r = call('POST', '/api/auth/register', {
    'username': 'ZeroT', 'password': 'abc123', 'displayName': '零测试', 'avatar': 'cat',
    'answers': [{'qid': 'q_father', 'answer': '王伟'}, {'qid': 'q_mother', 'answer': '李娜'}, {'qid': 'q_school', 'answer': '实验一小'}]})
show('register', r)
tok = r[1].get('token')
if r[0] != 200 or not tok:
    ok = False

show('me(auth)', call('GET', '/api/auth/me', token=tok))
show('me(guest)', call('GET', '/api/auth/me'))
show('register-dup', call('POST', '/api/auth/register', {'username': 'ZeroT', 'password': 'abc123', 'answers': [{'qid': 'q_father', 'answer': 'a'}, {'qid': 'q_mother', 'answer': 'b'}, {'qid': 'q_school', 'answer': 'c'}]}))
show('register-baduser', call('POST', '/api/auth/register', {'username': 'ab', 'password': 'abc123', 'answers': [{'qid': 'q_father', 'answer': 'a'}, {'qid': 'q_mother', 'answer': 'b'}, {'qid': 'q_school', 'answer': 'c'}]}))
show('register-badpw', call('POST', '/api/auth/register', {'username': 'GoodUs', 'password': '123', 'answers': [{'qid': 'q_father', 'answer': 'a'}, {'qid': 'q_mother', 'answer': 'b'}, {'qid': 'q_school', 'answer': 'c'}]}))
show('login-wrong', call('POST', '/api/auth/login', {'username': 'ZeroT', 'password': 'wrongpw'}))
r = call('POST', '/api/auth/login', {'username': 'ZeroT', 'password': 'abc123'})
show('login-ok', r)
tok2 = r[1].get('token')
r = call('POST', '/api/auth/change-password', {'oldPassword': 'abc123', 'newPassword': 'newABC9'}, token=tok2)
show('change-pw', r)
tok3 = r[1].get('token')
show('me-oldtok', call('GET', '/api/auth/me', token=tok))  # 应 401（清空旧会话）
show('update-me', call('PUT', '/api/auth/me', {'displayName': '零改'}, token=tok3))
show('recover-start', call('POST', '/api/auth/recover/start', {}))
show('recover-wrong', call('POST', '/api/auth/recover/verify', {'username': 'ZeroT', 'answers': [{'qid': 'q_father', 'answer': '错'}, {'qid': 'q_mother', 'answer': '李娜'}, {'qid': 'q_school', 'answer': '实验一小'}], 'newPassword': 'recov99'}))
r = call('POST', '/api/auth/recover/verify', {'username': 'ZeroT', 'answers': [{'qid': 'q_father', 'answer': '王伟'}, {'qid': 'q_mother', 'answer': '李娜'}, {'qid': 'q_school', 'answer': '实验一小'}], 'newPassword': 'recov99'})
show('recover-ok', r)
tok4 = r[1].get('token')
show('login-recov', call('POST', '/api/auth/login', {'username': 'ZeroT', 'password': 'recov99'}))
show('delete', call('POST', '/api/auth/delete-account', {'password': 'recov99'}, token=tok4))
show('login-after-del', call('POST', '/api/auth/login', {'username': 'ZeroT', 'password': 'recov99'}))  # 应 401
print('\nRESULT:', 'PASS' if ok else 'SEE ISSUES ABOVE')
