/**
 * 세종취합봇
 * ------------------------------------------------
 * 대시보드에서 만든 "방"(교재열람방, 취합방 등)을 실시간으로 자동 인식합니다.
 * 새 방이 대시보드에서 추가되면, 이 봇 코드를 다시 배포하지 않아도
 * /확인 명령과 자동 알림에 즉시 포함됩니다.
 *
 * 데이터 구조 (Firebase, sejong_unified 아래)
 *   members : 전체 회원 명단 + 텔레그램 연동 상태 (모든 방 공유)
 *   groups  : 대상자 그룹 (모든 방 공유)
 *   settings: 대시보드 암호 등
 *   tgConfig: 관리자 채팅 ID 목록
 *   rooms   : { roomId: { name, icon, items: { itemId: {...} } } }
 */

const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const express = require('express');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DB_URL = process.env.FIREBASE_DATABASE_URL;
const SERVICE_ACCOUNT_RAW = process.env.FIREBASE_SERVICE_ACCOUNT;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !DB_URL || !SERVICE_ACCOUNT_RAW) {
  console.error('❌ 환경변수 누락: TELEGRAM_BOT_TOKEN / FIREBASE_DATABASE_URL / FIREBASE_SERVICE_ACCOUNT 확인하세요.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(SERVICE_ACCOUNT_RAW)),
  databaseURL: DB_URL
});
const db = admin.database();
const ROOT = 'sejong_unified'; // 대시보드와 공유하는 통합 루트 경로 (절대 바꾸지 마세요)

const bot = new TelegramBot(TOKEN, { polling: true });

const app = express();
app.get('/', (req, res) => res.send('세종취합봇 실행중 ✅'));
app.listen(PORT, () => console.log(`healthcheck server on ${PORT}`));

/* ══════════════════ 공용 유틸 ══════════════════ */
async function getShared() {
  const [mSnap, gSnap, sSnap] = await Promise.all([
    db.ref(`${ROOT}/members`).once('value'),
    db.ref(`${ROOT}/groups`).once('value'),
    db.ref(`${ROOT}/settings`).once('value'),
  ]);
  return { members: mSnap.val() || {}, groups: gSnap.val() || {}, settings: sSnap.val() || {} };
}
async function getRoomModules() {
  const snap = await db.ref(`${ROOT}/rooms`).once('value');
  const rooms = snap.val() || {};
  return Object.entries(rooms).map(([roomId, room]) => ({
    key: roomId,
    path: `rooms/${roomId}/items`,
    icon: room.icon || '📋',
    noun: room.name || '항목'
  }));
}
async function getModuleItems(mod) {
  const snap = await db.ref(`${ROOT}/${mod.path}`).once('value');
  return snap.val() || {};
}
function findMemberByCode(members, code) {
  return Object.entries(members || {}).find(([, m]) => m.regCode === (code || '').trim().toUpperCase());
}
function findMemberByChatId(members, chatId) {
  return Object.entries(members || {}).find(([, m]) => m.tgChatId === chatId && m.tgStatus === 'linked');
}
function findPendingByChatId(members, chatId) {
  return Object.entries(members || {}).find(([, m]) => m.tgChatId === chatId && m.tgStatus === 'pending');
}
function itemTargetMemberIds(item, groups) {
  const set = {};
  Object.keys(item.groupIds || {}).forEach(gid => {
    const g = groups[gid];
    if (g) Object.keys(g.memberIds || {}).forEach(mid => { set[mid] = true; });
  });
  return Object.keys(set);
}
async function getAdminChatIds() {
  const snap = await db.ref(`${ROOT}/tgConfig/adminChatIds`).once('value');
  return Object.keys(snap.val() || {});
}
function memberLabel(m) {
  return `${m.name}${m.dept ? ' · ' + m.dept : ''}${m.pos ? ' · ' + m.pos : ''}`;
}

/* ══════════════════ /start ══════════════════ */
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const { members } = await getShared();
  const linked = findMemberByChatId(members, chatId);
  const pending = findPendingByChatId(members, chatId);

  if (linked) {
    const [, m] = linked;
    return bot.sendMessage(chatId,
      `안녕하세요, ${m.name}님! ✅ 이미 연동되어 있습니다.\n\n` +
      `📋 /확인 — 아직 확인하지 않은 항목 보기 (모든 방 통합)\n` +
      `👤 /상태 — 내 연동 상태 보기`);
  }
  if (pending) return bot.sendMessage(chatId, '⏳ 이미 승인 대기 중입니다. 관리자의 승인을 기다려주세요.');

  bot.sendMessage(chatId,
    `📋 세종취합봇입니다.\n교재열람확인, 참석확인 등 각종 확인을 이 봇 하나로 처리합니다.\n\n` +
    `관리자에게 전달받은 *고유코드*를 그대로 입력해주세요.\n(예: A7K2X9)`,
    { parse_mode: 'Markdown' });
});

/* ══════════════════ /상태 ══════════════════ */
bot.onText(/\/상태/, async (msg) => {
  const chatId = msg.chat.id;
  const { members } = await getShared();
  const linked = findMemberByChatId(members, chatId);
  const pending = findPendingByChatId(members, chatId);
  if (linked) return bot.sendMessage(chatId, `✅ 연동완료 — ${memberLabel(linked[1])}`);
  if (pending) return bot.sendMessage(chatId, `⏳ 승인대기 중 — ${memberLabel(pending[1])}`);
  bot.sendMessage(chatId, '⚪ 아직 연동되지 않았습니다. 고유코드를 입력해주세요.');
});

/* ══════════════════ /관리자등록 ══════════════════ */
bot.onText(/\/관리자등록(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const pw = (match[1] || '').trim();
  if (!pw) return bot.sendMessage(chatId, '사용법: /관리자등록 관리자암호');

  const { settings } = await getShared();
  const adminPw = settings.adminPw || 'admin1000!!';
  if (pw !== adminPw) return bot.sendMessage(chatId, '❌ 관리자 암호가 올바르지 않습니다.');

  await db.ref(`${ROOT}/tgConfig/adminChatIds/${chatId}`).set(true);
  bot.sendMessage(chatId, '✅ 관리자로 등록되었습니다. 이제 대상자의 연동 승인 요청을 이 채팅으로 받습니다.');
});

/* ══════════════════ /확인 : 모든 방을 통틀어 미확인 항목 조회 ══════════════════ */
bot.onText(/\/확인/, async (msg) => {
  const chatId = msg.chat.id;
  const { members, groups } = await getShared();
  const linked = findMemberByChatId(members, chatId);
  if (!linked) return bot.sendMessage(chatId, '먼저 고유코드를 입력해 연동해주세요. /start');
  const [mid] = linked;

  const mods = await getRoomModules();
  let rows = [];
  for (const mod of mods) {
    const items = await getModuleItems(mod);
    const pending = Object.entries(items).filter(([, it]) => {
      const targets = itemTargetMemberIds(it, groups);
      return targets.includes(mid) && !(it.confirms && it.confirms[mid]);
    });
    pending.forEach(([itemId, it]) => {
      rows.push([{ text: `${mod.icon} ${it.title}`, callback_data: `confirm:${mod.key}:${itemId}:${mid}` }]);
    });
  }

  if (!rows.length) return bot.sendMessage(chatId, '👍 확인할 항목이 없습니다. 모두 완료하셨어요!');
  bot.sendMessage(chatId, `미확인 항목 ${rows.length}건입니다. 눌러서 확인 처리하세요.`, {
    reply_markup: { inline_keyboard: rows }
  });
});

/* ══════════════════ 일반 텍스트 (고유코드 입력) ══════════════════ */
bot.on('message', async (msg) => {
  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) return;
  const chatId = msg.chat.id;

  const { members } = await getShared();
  const linked = findMemberByChatId(members, chatId);
  if (linked) return bot.sendMessage(chatId, '이미 연동되어 있어요. 📋 /확인 을 입력해보세요.');

  const pending = findPendingByChatId(members, chatId);
  if (pending) return bot.sendMessage(chatId, '⏳ 이미 승인 대기 중입니다. 관리자의 승인을 기다려주세요.');

  const found = findMemberByCode(members, text);
  if (!found) return bot.sendMessage(chatId, '❌ 코드를 찾을 수 없습니다. 관리자에게 코드를 다시 확인해주세요.');

  const [mid, m] = found;
  if (m.tgStatus === 'linked') {
    return bot.sendMessage(chatId, '이 코드는 이미 다른 텔레그램 계정과 연동되어 있습니다. 관리자에게 문의해주세요.');
  }

  await db.ref(`${ROOT}/members/${mid}`).update({
    tgStatus: 'pending',
    tgChatId: chatId,
    tgUsername: msg.from.username || ''
  });
  bot.sendMessage(chatId, `요청이 접수되었습니다. 관리자 승인을 기다려주세요. (${m.name}님)`);

  const adminChatIds = await getAdminChatIds();
  if (!adminChatIds.length) {
    return bot.sendMessage(chatId, '⚠️ 등록된 관리자가 없어 승인 요청을 보낼 수 없습니다. 관리자에게 문의해주세요.');
  }
  adminChatIds.forEach(adminChatId => {
    bot.sendMessage(adminChatId,
      `🙋 연동 승인 요청\n\n이름: ${m.name}\n부서: ${m.dept || '-'}\n직책: ${m.pos || '-'}\n텔레그램: @${msg.from.username || '(아이디 없음)'}`,
      { reply_markup: { inline_keyboard: [[
        { text: '✅ 승인', callback_data: `approve:${mid}` },
        { text: '❌ 거절', callback_data: `reject:${mid}` }
      ]] } });
  });
});

/* ══════════════════ 버튼 콜백 ══════════════════ */
bot.on('callback_query', async (q) => {
  const parts = q.data.split(':');
  const action = parts[0];
  const chatId = q.message.chat.id;

  try {
    if (action === 'approve' || action === 'reject') {
      const mid = parts[1];
      const mSnap = await db.ref(`${ROOT}/members/${mid}`).once('value');
      const m = mSnap.val();
      if (!m) return bot.answerCallbackQuery(q.id, { text: '이미 처리되었거나 존재하지 않는 요청입니다.' });

      if (action === 'approve') {
        await db.ref(`${ROOT}/members/${mid}`).update({ tgStatus: 'linked' });
        await bot.answerCallbackQuery(q.id, { text: '승인 완료' });
        await bot.editMessageText(`✅ 승인 완료 — ${m.name}`, { chat_id: chatId, message_id: q.message.message_id });
        if (m.tgChatId) bot.sendMessage(m.tgChatId, '🎉 연동이 승인되었습니다! 이제 각 방의 새 항목 알림을 받고, /확인 으로 직접 조회할 수도 있습니다.');
      } else {
        await db.ref(`${ROOT}/members/${mid}`).update({ tgStatus: 'none', tgChatId: null, tgUsername: null });
        await bot.answerCallbackQuery(q.id, { text: '거절 처리됨' });
        await bot.editMessageText(`❌ 거절됨 — ${m.name}`, { chat_id: chatId, message_id: q.message.message_id });
        if (m.tgChatId) bot.sendMessage(m.tgChatId, '요청이 거절되었습니다. 코드가 맞는지 관리자에게 확인해주세요.');
      }
      return;
    }

    if (action === 'confirm') {
      const [, roomId, itemId, mid] = parts;
      await db.ref(`${ROOT}/rooms/${roomId}/items/${itemId}/confirms/${mid}`).set(Date.now());
      await bot.answerCallbackQuery(q.id, { text: '확인 처리되었습니다 ✅' });

      if (q.message.reply_markup && q.message.reply_markup.inline_keyboard.length > 1) {
        const kb = q.message.reply_markup.inline_keyboard.filter(row => row[0].callback_data !== q.data);
        await bot.editMessageReplyMarkup({ inline_keyboard: kb }, { chat_id: chatId, message_id: q.message.message_id });
      } else {
        await bot.editMessageText(`${q.message.text}\n\n✅ 확인 완료`, { chat_id: chatId, message_id: q.message.message_id });
      }
    }
  } catch (e) {
    console.error('callback error:', e.message);
  }
});

/* ══════════════════ 새 항목 등록 시 자동 알림(푸시) ══════════════════ */
async function maybeNotify(roomId, itemPath, itemId, item) {
  if (!item || item.notified) return;
  const lockRef = db.ref(`${ROOT}/${itemPath}/${itemId}/notified`);
  const result = await lockRef.transaction(cur => (cur ? undefined : true));
  if (!result.committed) return;

  const meta = roomMeta[roomId] || { icon: '📋', noun: '항목' };
  const { members, groups } = await getShared();
  const targets = itemTargetMemberIds(item, groups)
    .map(mid => [mid, members[mid]])
    .filter(([, m]) => m && m.tgStatus === 'linked' && m.tgChatId);

  for (const [mid, m] of targets) {
    try {
      await bot.sendMessage(m.tgChatId,
        `${meta.icon} [${meta.noun}] 새 항목이 등록되었습니다.\n\n제목: ${item.title}\n주제: ${item.topic || '-'}\n날짜: ${item.date || '-'}\n\n확인 후 아래 버튼을 눌러주세요.`,
        { reply_markup: { inline_keyboard: [[{ text: '✅ 확인', callback_data: `confirm:${roomId}:${itemId}:${mid}` }]] } });
    } catch (e) {
      console.error(`알림 실패 (${m.name}):`, e.message);
    }
  }
  console.log(`📨 [${meta.noun}] "${item.title}" 알림 발송 완료 (${targets.length}명)`);
}

/* ══════════════════ 방(rooms) 실시간 자동 인식 ══════════════════
   대시보드에서 새 방을 만들면 여기서 자동으로 감지해 알림 리스너를 붙입니다.
   봇 코드를 다시 배포할 필요가 없습니다. */
const roomMeta = {};
const attachedRooms = new Set();
function updateRoomMeta(roomId, room) {
  roomMeta[roomId] = { icon: (room && room.icon) || '📋', noun: (room && room.name) || '항목' };
}
function attachRoomListener(roomId, room) {
  updateRoomMeta(roomId, room);
  if (attachedRooms.has(roomId)) return;
  attachedRooms.add(roomId);
  const itemPath = `rooms/${roomId}/items`;
  db.ref(`${ROOT}/${itemPath}`).on('child_added', snap => maybeNotify(roomId, itemPath, snap.key, snap.val()));
  db.ref(`${ROOT}/${itemPath}`).on('child_changed', snap => maybeNotify(roomId, itemPath, snap.key, snap.val()));
  console.log(`🗂️ 방 감지: ${roomMeta[roomId].icon} ${roomMeta[roomId].noun}`);
}
db.ref(`${ROOT}/rooms`).on('child_added', snap => attachRoomListener(snap.key, snap.val()));
db.ref(`${ROOT}/rooms`).on('child_changed', snap => updateRoomMeta(snap.key, snap.val()));

console.log('🤖 세종취합봇 시작됨 (방 구조 자동 인식 모드)');
