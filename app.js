const fileInput = document.getElementById('fileInput');
const conversationList = document.getElementById('conversationList');
const chatEmpty = document.getElementById('chatEmpty');
const chatView = document.getElementById('chatView');
const chatAvatar = document.getElementById('chatAvatar');
const chatHeaderName = document.getElementById('chatHeaderName');
const chatHeaderNameInput = document.getElementById('chatHeaderNameInput');
const editNameBtn = document.getElementById('editNameBtn');
const messagesEl = document.getElementById('messages');

// conversations keyed by filename -> { name, messages, otherName }
const conversations = {};
let activeKey = null;

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

fileInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  files.forEach(readFile);
  fileInput.value = '';
});

function readFile(file) {
  const isPdf = /\.pdf$/i.test(file.name);
  const reader = new FileReader();
  reader.onload = async () => {
    let messages;
    try {
      messages = isPdf
        ? await parsePdfTranscript(reader.result)
        : parseTranscript(reader.result);
    } catch (err) {
      console.error(err);
      alert(`Couldn't read ${file.name}: ${err.message}`);
      return;
    }
    if (!messages.length) {
      alert(`Couldn't find any messages in ${file.name}`);
      return;
    }
    const otherName = messages.find(m => !m.outgoing)?.sender || 'Unknown';
    const key = file.name + '-' + Date.now();
    conversations[key] = { name: otherName, messages, fileName: file.name };
    renderConversationList();
    selectConversation(key);
  };
  if (isPdf) reader.readAsArrayBuffer(file);
  else reader.readAsText(file);
}

function messagesFromEntries(entries) {
  const messages = [];
  for (const entry of entries) {
    const rightLines = entry.rightLines;
    if (!rightLines.length) continue;
    const m = rightLines[0].match(/^([^:]+):\s?(.*)$/);
    if (!m) continue;
    const sender = m[1].trim();
    let text = m[2];
    if (text.startsWith(': ')) text = text.slice(2);
    else if (text.startsWith(':')) text = text.slice(1);
    for (const cont of rightLines.slice(1)) text += '\n' + cont;

    const meta = entry.leftLines.join(' ');
    const sentMatch = meta.match(/Sent:\s*(.+)$/);
    const time = sentMatch ? sentMatch[1].trim() : '';
    const delivered = /Delivered:/.test(meta);

    messages.push({
      sender,
      text,
      time,
      delivered,
      outgoing: sender.toLowerCase() === 'you',
    });
  }
  return messages;
}

async function parsePdfTranscript(arrayBuffer) {
  if (!window.pdfjsLib) throw new Error('PDF support failed to load');
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const entries = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const items = content.items
      .map(it => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        width: it.width,
        height: Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || 10,
      }))
      .filter(it => it.str.trim().length);
    if (!items.length) continue;

    // drop the large-font page heading (contact name)
    const heights = items.map(it => it.height).sort((a, b) => a - b);
    const normalHeight = heights[Math.floor(heights.length / 2)];
    const bodyItems = items.filter(it => it.height <= normalHeight * 1.25);

    // group items into visual lines by y-position
    const sorted = [...bodyItems].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      let line = lines.find(l => Math.abs(l.y - it.y) <= 2.5);
      if (!line) {
        line = { y: it.y, items: [] };
        lines.push(line);
      }
      line.items.push(it);
    }
    lines.sort((a, b) => b.y - a.y);
    lines.forEach(l => l.items.sort((a, b) => a.x - b.x));

    // find a global column split point from lines with a wide internal gap
    const splitCandidates = [];
    for (const line of lines) {
      for (let i = 0; i < line.items.length - 1; i++) {
        const gap = line.items[i + 1].x - (line.items[i].x + line.items[i].width);
        if (gap > 15) splitCandidates.push(line.items[i + 1].x);
      }
    }
    const colX = splitCandidates.length
      ? splitCandidates.sort((a, b) => a - b)[Math.floor(splitCandidates.length / 2)]
      : null;

    const rows = lines.map(line => {
      let leftText = '';
      let rightText = '';
      if (colX != null) {
        const left = line.items.filter(it => it.x < colX - 5);
        const right = line.items.filter(it => it.x >= colX - 5);
        leftText = left.map(it => it.str).join('').trim();
        rightText = right.map(it => it.str).join('').trim();
      } else {
        leftText = line.items.map(it => it.str).join('').trim();
      }
      return { y: line.y, leftText, rightText };
    });

    // a row starts a new entry when its left cell begins a fresh metadata
    // block (Delivered:/Read:/Sent:) -- wrapped continuation lines never do
    const metaStartRe = /^(Delivered|Read|Sent):/i;
    let currentEntry = null;
    rows.forEach(row => {
      const isNewEntry = metaStartRe.test(row.leftText);
      if (isNewEntry || !currentEntry) {
        currentEntry = { leftLines: [], rightLines: [] };
        entries.push(currentEntry);
      }
      if (row.leftText) currentEntry.leftLines.push(row.leftText);
      if (row.rightText) currentEntry.rightLines.push(row.rightText);
    });
  }

  return messagesFromEntries(entries);
}

function parseTranscript(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const lineRe = /^\((.*?)\)\s*([^:]+):\s?(.*)$/;
  const messages = [];

  for (const line of lines) {
    const m = line.match(lineRe);
    if (!m) {
      // continuation of a multi-line message
      if (messages.length) messages[messages.length - 1].text += '\n' + line;
      continue;
    }
    const [, meta, senderRaw, restRaw] = m;
    const sender = senderRaw.trim();
    let text = restRaw;
    // transcripts sometimes have a stray leading ": " artifact
    if (text.startsWith(': ')) text = text.slice(2);
    else if (text.startsWith(':')) text = text.slice(1);

    const sentMatch = meta.match(/Sent:\s*(.+)$/);
    const time = sentMatch ? sentMatch[1].trim() : '';
    const delivered = /Delivered:/.test(meta);

    messages.push({
      sender,
      text,
      time,
      delivered,
      outgoing: sender.toLowerCase() === 'you',
    });
  }
  return messages;
}

function renderConversationList() {
  conversationList.innerHTML = '';
  const keys = Object.keys(conversations);
  if (!keys.length) {
    conversationList.innerHTML = '<div class="empty-state-small">Upload a transcript to begin</div>';
    return;
  }
  keys.forEach(key => {
    const convo = conversations[key];
    const last = convo.messages[convo.messages.length - 1];
    const item = document.createElement('div');
    item.className = 'conversation-item' + (key === activeKey ? ' active' : '');
    item.innerHTML = `
      <div class="conv-avatar">${initials(convo.name)}</div>
      <div class="conv-meta">
        <div class="conv-name">${escapeHtml(convo.name)}</div>
        <div class="conv-preview">${escapeHtml(last.text)}</div>
      </div>
      <button class="delete-conv-btn" title="Remove conversation">
        <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 7h12l-1 14H7L6 7zm3-3h6l1 2H8l1-2zM4 6h16v2H4V6z"/></svg>
      </button>
    `;
    item.addEventListener('click', () => selectConversation(key));
    item.querySelector('.delete-conv-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(key);
    });
    conversationList.appendChild(item);
  });
}

function deleteConversation(key) {
  const convo = conversations[key];
  if (!confirm(`Remove conversation with ${convo.name}?`)) return;
  delete conversations[key];
  if (activeKey === key) {
    activeKey = null;
    cancelNameEdit();
    chatView.style.display = 'none';
    chatEmpty.style.display = 'flex';
  }
  renderConversationList();
}

function selectConversation(key) {
  activeKey = key;
  cancelNameEdit();
  renderConversationList();
  const convo = conversations[key];
  chatEmpty.style.display = 'none';
  chatView.style.display = 'flex';
  chatAvatar.textContent = initials(convo.name);
  chatHeaderName.textContent = convo.name;
  renderMessages(convo.messages);
}

function startNameEdit() {
  if (!activeKey) return;
  const convo = conversations[activeKey];
  chatHeaderNameInput.value = convo.name;
  chatHeaderName.hidden = true;
  chatHeaderNameInput.hidden = false;
  chatHeaderNameInput.focus();
  chatHeaderNameInput.select();
}

function commitNameEdit() {
  if (!activeKey) return;
  const newName = chatHeaderNameInput.value.trim();
  if (newName) {
    const convo = conversations[activeKey];
    convo.name = newName;
    convo.messages.forEach(m => {
      if (!m.outgoing) m.sender = newName;
    });
    chatAvatar.textContent = initials(convo.name);
    chatHeaderName.textContent = convo.name;
    renderConversationList();
    renderMessages(convo.messages);
  }
  cancelNameEdit();
}

function cancelNameEdit() {
  chatHeaderNameInput.hidden = true;
  chatHeaderName.hidden = false;
}

editNameBtn.addEventListener('click', startNameEdit);
chatHeaderName.addEventListener('dblclick', startNameEdit);
chatHeaderNameInput.addEventListener('blur', commitNameEdit);
chatHeaderNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') chatHeaderNameInput.blur();
  if (e.key === 'Escape') cancelNameEdit();
});

function renderMessages(messages) {
  messagesEl.innerHTML = '';
  let lastTime = null;
  let currentGroupEl = null;
  let currentGroupSender = null;

  messages.forEach((msg, idx) => {
    if (msg.time && msg.time !== lastTime) {
      const divider = document.createElement('div');
      divider.className = 'time-divider';
      divider.textContent = msg.time;
      messagesEl.appendChild(divider);
      lastTime = msg.time;
      currentGroupSender = null; // force new group after a divider
    }

    if (msg.sender !== currentGroupSender) {
      currentGroupEl = document.createElement('div');
      currentGroupEl.className = 'msg-group ' + (msg.outgoing ? 'outgoing' : 'incoming');

      if (!msg.outgoing) {
        const label = document.createElement('div');
        label.className = 'sender-label';
        label.textContent = msg.sender;
        currentGroupEl.appendChild(label);
      }

      const row = document.createElement('div');
      row.className = 'bubble-row';

      const avatar = document.createElement('div');
      avatar.className = 'bubble-avatar';
      avatar.textContent = initials(msg.sender);

      const stack = document.createElement('div');
      stack.className = 'stack';

      row.appendChild(avatar);
      row.appendChild(stack);
      currentGroupEl.appendChild(row);
      currentGroupEl._stack = stack;
      currentGroupEl._avatar = avatar;

      messagesEl.appendChild(currentGroupEl);
      currentGroupSender = msg.sender;
    }

    const wrap = document.createElement('div');
    wrap.className = 'bubble-wrap';

    wrap.addEventListener('click', () => wrap.classList.toggle('show-time'));

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = msg.text;
    wrap.appendChild(bubble);

    const timeTag = document.createElement('div');
    timeTag.className = 'time-tag';
    timeTag.textContent = (msg.outgoing ? 'Sent ' : 'Received ') + msg.time;
    wrap.appendChild(timeTag);

    currentGroupEl._stack.appendChild(wrap);

    // show avatar only on the last bubble of an incoming group
    const nextMsg = messages[idx + 1];
    if (!msg.outgoing) {
      const nextSameGroup = nextMsg && nextMsg.sender === msg.sender;
      if (!nextSameGroup) currentGroupEl._avatar.classList.add('show');
    }

    if (msg.outgoing && msg.delivered) {
      const nextSameGroup = nextMsg && nextMsg.sender === msg.sender;
      if (!nextSameGroup) {
        const delivered = document.createElement('div');
        delivered.className = 'delivered-label';
        delivered.textContent = 'Delivered';
        currentGroupEl._stack.appendChild(delivered);
      }
    }
  });

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
