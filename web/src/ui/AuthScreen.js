/**
 * 账号 UI：右上角账号条 + 登录/注册/找回密码弹层 + 个人空间（设置）弹层。
 *
 * 安全约定：
 *  - 用户名 / 昵称等用户内容一律走 textContent（h 的 text prop），绝不 innerHTML，防 XSS。
 *  - 登录 token 由 net/api.js 的 auth 单例管理并自动附加到请求头。
 *  - 弹层打开时通过 onOverlayChange 通知 App 禁用 Phaser 地图点击，防事件穿透。
 */
import { h, clear, toast } from './dom.js';
import { auth, SECURITY_QUESTIONS } from '../net/api.js';

const AVATARS = ['🦊', '🐼', '🐯', '🦁', '🐧', '🐙', '🐲', '🦉', '🐶', '🐱'];

function escLen(s) { return (s || '').trim().length; }

export default class AuthScreen {
  constructor(host, session, handlers = {}) {
    this.host = host;
    this.session = session;
    this.handlers = handlers;       // { onLoggedIn, onLoggedOut, onOverlayChange }
    this.overlay = null;            // 弹层根
    this.bar = h('div#accountbar');
    this.host.appendChild(this.bar);
    this.renderBar();
  }

  // ---------------- 右上角账号条 ----------------

  renderBar() {
    clear(this.bar);
    if (auth.isLoggedIn) {
      const u = auth.user || {};
      const av = u.avatar || AVATARS[0];
      const name = u.displayName || u.username || '玩家';
      this.bar.appendChild(h('div.acct-chip', {
        onclick: () => this.openSettings(),
      },
        h('span.acct-av', { text: av }),
        h('span.acct-name', { text: name }),
      ));
      this.bar.appendChild(h('button.acct-btn', {
        onclick: () => this.confirmLogout(),
      }, '退出'));
    } else {
      this.bar.appendChild(h('button.acct-btn.primary', {
        onclick: () => this.openLogin(),
      }, '登录 / 注册'));
    }
  }

  async confirmLogout() {
    if (!confirm('确定退出登录吗？你当前所在的房间座位仍会保留（刷新可凭房间身份回到本局）。')) return;
    try { await auth.logout(); } catch { /* 忽略 */ }
    auth.clear();
    this.renderBar();
    this.handlers.onLoggedOut && this.handlers.onLoggedOut();
    toast('已退出登录', 'info');
  }

  // ---------------- 弹层基础 ----------------

  _open(node) {
    this._close();
    this.overlay = h('div.auth-overlay', {
      onclick: (e) => { if (e.target === this.overlay) this._close(); },
    }, h('div.auth-card', null, node));
    this.host.appendChild(this.overlay);
    this.handlers.onOverlayChange && this.handlers.onOverlayChange(true);
  }

  _close() {
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
    this.handlers.onOverlayChange && this.handlers.onOverlayChange(false);
  }

  _tabs(active) {
    const mk = (mode, label) => h('div.auth-tab' + (mode === active ? '.active' : ''), {
      onclick: () => {
        if (mode === 'login') this.openLogin();
        else if (mode === 'register') this.openRegister();
        else this.openRecover();
      },
    }, label);
    return h('div.auth-tabs', null, mk('login', '登录'), mk('register', '注册'), mk('recover', '找回密码'));
  }

  // ---------------- 登录 ----------------

  openLogin() {
    const userIn = h('input.acct-input', { placeholder: '用户名（3-7 位）', maxlength: 16, autofocus: 'autofocus' });
    const pwdIn = h('input.acct-input', { type: 'password', placeholder: '密码（6-11 位）', maxlength: 32 });
    const submit = async () => {
      const username = userIn.value.trim();
      const password = pwdIn.value;
      if (!username || !password) return toast('请输入用户名和密码', 'err');
      try {
        const r = await auth.login(username, password);
        auth.save(r.token, r.user);
        this.renderBar();
        this._close();
        this.handlers.onLoggedIn && this.handlers.onLoggedIn(r.user);
        toast('登录成功，欢迎回来 ' + (r.user.displayName || r.user.username), 'ok');
      } catch (e) { toast(e.message || '登录失败', 'err', 5000); }
    };
    pwdIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    this._open(h('div', null,
      this._tabs('login'),
      h('h2.acct-h', null, '登录'),
      h('div.acct-field', null, userIn),
      h('div.acct-field', null, pwdIn),
      h('button.acct-submit', { onclick: submit }, '登录'),
    ));
    setTimeout(() => userIn.focus(), 0);
  }

  // ---------------- 注册 ----------------

  openRegister() {
    const userIn = h('input.acct-input', { placeholder: '用户名（3-7 位，字母/数字/中文）', maxlength: 16, autofocus: 'autofocus' });
    const pwdIn = h('input.acct-input', { type: 'password', placeholder: '密码（6-11 位）', maxlength: 32 });
    const pwd2In = h('input.acct-input', { type: 'password', placeholder: '确认密码', maxlength: 32 });
    const nameIn = h('input.acct-input', { placeholder: '昵称（可选，留空同用户名）', maxlength: 16 });
    const ansInputs = {};
    const qNodes = SECURITY_QUESTIONS.map((q) => {
      const inp = h('input.acct-input', { placeholder: '答案', maxlength: 64 });
      ansInputs[q.qid] = inp;
      return h('div.acct-q', null, h('label.acct-qlabel', { text: q.question }), inp);
    });
    const submit = async () => {
      const username = userIn.value.trim();
      const password = pwdIn.value;
      const password2 = pwd2In.value;
      const displayName = nameIn.value.trim();
      if (username.length < 3 || username.length > 7) return toast('用户名须 3-7 位', 'err');
      if (password.length < 6 || password.length > 11) return toast('密码须 6-11 位', 'err');
      if (password !== password2) return toast('两次密码不一致', 'err');
      const answers = SECURITY_QUESTIONS.map((q) => ({ qid: q.qid, answer: ansInputs[q.qid].value }));
      if (answers.some((a) => !a.answer.trim())) return toast('请完整填写安全问题', 'err');
      try {
        const r = await auth.register({
          username, password, displayName,
          avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
          answers,
        });
        auth.save(r.token, r.user);
        this.renderBar();
        this._close();
        this.handlers.onLoggedIn && this.handlers.onLoggedIn(r.user);
        toast('注册成功，已自动登录', 'ok');
      } catch (e) {
        toast(e.message || '注册失败', 'err', 5000);
      }
    };
    pwd2In.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    this._open(h('div', null,
      this._tabs('register'),
      h('h2.acct-h', null, '注册账号'),
      h('div.acct-field', null, userIn),
      h('div.acct-field', null, pwdIn),
      h('div.acct-field', null, pwd2In),
      h('div.acct-field', null, nameIn),
      h('div.acct-qblock', null, ...qNodes),
      h('button.acct-submit', { onclick: submit }, '注册并登录'),
    ));
    setTimeout(() => userIn.focus(), 0);
  }

  // ---------------- 找回密码 ----------------

  openRecover() {
    const userIn = h('input.acct-input', { placeholder: '用户名', maxlength: 16, autofocus: 'autofocus' });
    const step1 = async () => {
      const username = userIn.value.trim();
      if (!username) return toast('请输入用户名', 'err');
      let questions;
      try { questions = (await auth.recoverStart()).questions; }
      catch (e) { return toast(e.message || '获取问题失败', 'err'); }
      const ansInputs = {};
      const qNodes = questions.map((q) => {
        const inp = h('input.acct-input', { placeholder: '答案', maxlength: 64 });
        ansInputs[q.qid] = inp;
        return h('div.acct-q', null, h('label.acct-qlabel', { text: q.question }), inp);
      });
      const pwIn = h('input.acct-input', { type: 'password', placeholder: '新密码（6-11 位）', maxlength: 32 });
      const pw2In = h('input.acct-input', { type: 'password', placeholder: '确认新密码', maxlength: 32 });
      const submit = async () => {
        const np = pwIn.value, np2 = pw2In.value;
        if (np.length < 6 || np.length > 11) return toast('新密码须 6-11 位', 'err');
        if (np !== np2) return toast('两次密码不一致', 'err');
        const answers = questions.map((q) => ({ qid: q.qid, answer: ansInputs[q.qid].value }));
        if (answers.some((a) => !a.answer.trim())) return toast('请完整回答安全问题', 'err');
        try {
          const r = await auth.recoverVerify(username, answers, np);
          auth.save(r.token, r.user);
          this.renderBar();
          this._close();
          this.handlers.onLoggedIn && this.handlers.onLoggedIn(r.user);
          toast('密码已重置，已自动登录', 'ok');
        } catch (e) { toast(e.message || '验证失败', 'err', 5000); }
      };
      pw2In.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      this._open(h('div', null,
        this._tabs('recover'),
        h('h2.acct-h', null, '找回密码'),
        h('div.acct-qblock', null, ...qNodes),
        h('div.acct-field', null, pwIn),
        h('div.acct-field', null, pw2In),
        h('button.acct-submit', { onclick: submit }, '验证并重置'),
      ));
    };
    userIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') step1(); });
    this._open(h('div', null,
      this._tabs('recover'),
      h('h2.acct-h', null, '找回密码'),
      h('div.acct-note', { text: '输入用户名后，回答注册时设置的安全问题即可重置密码。' }),
      h('div.acct-field', null, userIn),
      h('button.acct-submit', { onclick: step1 }, '下一步'),
    ));
    setTimeout(() => userIn.focus(), 0);
  }

  // ---------------- 个人空间（设置） ----------------

  openSettings() {
    if (!auth.isLoggedIn) return this.openLogin();
    const u = auth.user || {};

    // 头像选择
    let pickedAvatar = u.avatar || AVATARS[0];
    const avRow = h('div.acct-avatars', null, ...AVATARS.map((a) =>
      h('span.acct-avopt' + (a === pickedAvatar ? '.sel' : ''), {
        text: a,
        onclick: () => {
          pickedAvatar = a;
          [...avRow.children].forEach((c) => c.classList.toggle('sel', c.textContent === a));
        },
      })));

    const nameIn = h('input.acct-input', { value: u.displayName || '', placeholder: '昵称（最多 16 字）', maxlength: 16 });

    // 资料保存
    const saveProfile = async () => {
      try {
        const r = await auth.updateProfile(nameIn.value.trim(), pickedAvatar);
        auth.save(auth.token, r.user);
        this.renderBar();
        toast('资料已保存', 'ok');
      } catch (e) { toast(e.message || '保存失败', 'err'); }
    };

    // 修改密码
    const oldP = h('input.acct-input', { type: 'password', placeholder: '原密码', maxlength: 32 });
    const newP = h('input.acct-input', { type: 'password', placeholder: '新密码（6-11 位）', maxlength: 32 });
    const newP2 = h('input.acct-input', { type: 'password', placeholder: '确认新密码', maxlength: 32 });
    const doChange = async () => {
      if (newP.value.length < 6 || newP.value.length > 11) return toast('新密码须 6-11 位', 'err');
      if (newP.value !== newP2.value) return toast('两次密码不一致', 'err');
      try {
        const r = await auth.changePassword(oldP.value, newP.value);
        auth.save(r.token, r.user);   // 改密后服务端换发新 token，本机保持登录
        this.renderBar();
        toast('密码已修改，其他设备已退出', 'ok');
        oldP.value = newP.value = newP2.value = '';
      } catch (e) { toast(e.message || '修改失败', 'err'); }
    };

    // 注销账号
    const delP = h('input.acct-input', { type: 'password', placeholder: '输入密码确认注销', maxlength: 32 });
    const doDelete = async () => {
      if (!confirm('注销后账号与所有资料永久删除，且会退出当前房间账号绑定。确定吗？')) return;
      try {
        await auth.deleteAccount(delP.value);
        auth.clear();
        this.renderBar();
        this._close();
        this.handlers.onLoggedOut && this.handlers.onLoggedOut();
        toast('账号已注销', 'info');
      } catch (e) { toast(e.message || '注销失败', 'err'); }
    };

    this._open(h('div', null,
      h('div.auth-set-head', null,
        h('span.acct-av.big', { text: pickedAvatar }),
        h('div', null,
          h('div.acct-uname', { text: u.username || '' }),
          h('div.acct-sub', { text: '个人空间' }),
        ),
        h('button.acct-x', { onclick: () => this._close() }, '✕'),
      ),
      h('h3.acct-sec', null, '个人资料'),
      h('div.acct-field', null, nameIn),
      h('div.acct-avatars', null, avRow),
      h('button.acct-submit', { onclick: saveProfile }, '保存资料'),

      h('h3.acct-sec', null, '修改密码'),
      h('div.acct-field', null, oldP),
      h('div.acct-field', null, newP),
      h('div.acct-field', null, newP2),
      h('button.acct-submit', { onclick: doChange }, '修改密码'),

      h('h3.acct-sec.danger', null, '账号注销'),
      h('div.acct-note.warn', { text: '注销不可恢复；当前房间座位会保留但不再绑定账号。' }),
      h('div.acct-field', null, delP),
      h('button.acct-submit.danger', { onclick: doDelete }, '注销账号'),
    ));
  }
}
