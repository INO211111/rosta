const express = require('express');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// JSON file store. Set DATA_DIR=/data on Railway with a Volume mounted at /data for persistence across deploys.
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'votes.json');

let store = { votes: { ja: 0, nej: 0, vetej: 0 }, voters: {} };

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (parsed && parsed.votes && parsed.voters) {
        store = parsed;
      }
    }
    console.log('Vote store loaded from', DATA_FILE);
  } catch (err) {
    console.error('Store load error:', err.message);
  }
}

function saveStore() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('Store save error:', err.message);
  }
}

const VOTE_COOKIE_NAME = 'rosta_vote';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000;
const VALID_OPTIONS = ['ja', 'nej', 'vetej'];

app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const voteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'För många begäranden, försök igen om en minut' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);
app.use('/api/vote', voteLimiter);

function generateVoterHash(req) {
  const ip = req.ip || 'unknown';
  const ua = req.get('user-agent') || 'unknown';
  const combined = `${ip}|${ua}`;
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function getExistingVote(req) {
  return req.cookies[VOTE_COOKIE_NAME] || null;
}

function setVoteCookie(res, option) {
  res.cookie(VOTE_COOKIE_NAME, option, {
    maxAge: COOKIE_MAX_AGE,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });
}

function clearVoteCookie(res) {
  res.clearCookie(VOTE_COOKIE_NAME, { path: '/' });
}

function getStats() {
  const votes = {
    ja: store.votes.ja || 0,
    nej: store.votes.nej || 0,
    vetej: store.votes.vetej || 0
  };
  const total = votes.ja + votes.nej + votes.vetej;
  const percentages = {};
  VALID_OPTIONS.forEach((key) => {
    percentages[key] = total > 0 ? Math.round((votes[key] / total) * 100) : 0;
  });
  return { votes, percentages, total };
}

app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

app.get('/api/my-vote', (req, res) => {
  res.json({ vote: getExistingVote(req) });
});

app.post('/api/vote', (req, res) => {
  try {
    const { option } = req.body;

    if (!option || !VALID_OPTIONS.includes(option)) {
      return res.status(400).json({ error: 'Ogiltigt alternativ' });
    }

    const voterHash = generateVoterHash(req);
    const previousVote = store.voters[voterHash] || null;

    if (previousVote === option) {
      setVoteCookie(res, option);
      return res.json({ success: true, changed: false, vote: option });
    }

    if (previousVote && VALID_OPTIONS.includes(previousVote)) {
      store.votes[previousVote] = Math.max(0, (store.votes[previousVote] || 0) - 1);
    }

    store.votes[option] = (store.votes[option] || 0) + 1;
    store.voters[voterHash] = option;
    saveStore();

    setVoteCookie(res, option);
    res.json({ success: true, changed: previousVote !== null, vote: option });
  } catch (err) {
    console.error('Vote error:', err);
    res.status(500).json({ error: 'Kunde inte registrera röst' });
  }
});

app.post('/api/vote/remove', (req, res) => {
  try {
    const voterHash = generateVoterHash(req);
    const previousVote = store.voters[voterHash] || null;

    if (previousVote && VALID_OPTIONS.includes(previousVote)) {
      store.votes[previousVote] = Math.max(0, (store.votes[previousVote] || 0) - 1);
      delete store.voters[voterHash];
      saveStore();
    }

    clearVoteCookie(res);
    res.json({ success: true });
  } catch (err) {
    console.error('Remove vote error:', err);
    res.status(500).json({ error: 'Kunde inte ta bort röst' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', db: 'json', total: getStats().total, timestamp: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internt serverfel' });
});

function start() {
  loadStore();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start();
