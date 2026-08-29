/**
 * 服务器 REST 客户端。
 *
 * API 基址解析顺序：
 *   1) ?api=http://192.168.1.9:8765  —— 手动指定（跨设备调试最稳）
 *   2) Vite 开发端口(5173/4173) → 同主机 8765 端口
 *   3) 其余情况 → 同源（后端托管 web/dist 时的正常形态）
 * 局域网里其他设备访问的是主机 IP，location.hostname 天然就是主机 IP，无需额外配置。
 */
const qs = new URLSearchParams(location.search);
const DEV_PORTS = ['5173', '4173', '3000'];

export const API_BASE = (() => {
  const manual = qs.get('api');
  if (manual) return manual.replace(/\/$/, '');
  if (DEV_PORTS.includes(location.port)) return `${location.protocol}//${location.hostname}:8765`;
  return '';
})();

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, { body, params, signal } = {}) {
  let url = API_BASE + path;
  if (params) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') sp.set(k, v);
    }
    const s = sp.toString();
    if (s) url += `?${s}`;
  }
  const init = { method, signal, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.detail || data.message)) || `HTTP ${res.status}`;
    throw new ApiError(typeof msg === 'string' ? msg : JSON.stringify(msg), res.status, data);
  }
  return data;
}

export const api = {
  health: () => request('GET', '/api/health'),
  staticData: () => request('GET', '/api/static-data'),

  listRooms: () => request('GET', '/api/rooms'),
  createRoom: (roomName, playerName, withBot = false, password = '') =>
    request('POST', '/api/rooms', { body: { roomName, playerName, withBot: !!withBot, password: password || '' } }),
  joinRoom: (roomId, playerName, password = '') => request('POST', `/api/rooms/${roomId}/join`, { body: { playerName, password: password || '' } }),
  leaveRoom: (roomId, token) => request('POST', `/api/rooms/${roomId}/leave`, { body: { token } }),
  setReady: (roomId, token, ready) => request('POST', `/api/rooms/${roomId}/ready`, { body: { token, ready } }),
  start: (roomId, token, seed) => request('POST', `/api/rooms/${roomId}/start`, { body: { token, seed: seed ?? null } }),
  restart: (roomId, token) => request('POST', `/api/rooms/${roomId}/restart`, { body: { token } }),

  /** 取状态；传 since + wait 进入长轮询（服务端在状态变化或超时后才返回）。 */
  state: (roomId, token, { since = '', wait = 0, signal } = {}) =>
    request('GET', `/api/rooms/${roomId}/state`, { params: { token, since, wait }, signal }),

  action: (roomId, token, action) => request('POST', `/api/rooms/${roomId}/action`, { body: { token, action } }),
  endTurn: (roomId, token) => request('POST', `/api/rooms/${roomId}/end-turn`, { body: { token } }),
  /** 陪练房调试补给（仅机器人房可用）：加钱 / 加行动点。 */
  cheat: (roomId, token, { money = 0, actionPoints = 0 } = {}) =>
    request('POST', `/api/rooms/${roomId}/cheat`, { body: { token, money, actionPoints } }),
  preview: (roomId, token, location, coal = 0, iron = 0) =>
    request('GET', `/api/rooms/${roomId}/preview`, { params: { token, location, coal, iron } }),

  /** 玩家留言（公开意见箱，无需登录）：text 必填，contact 选填。 */
  feedback: (text, contact = '') =>
    request('POST', '/api/feedback', { body: { text, contact: contact || '' } }),
};

export default api;
