// Standalone mainnet wallet test. No build step. No secrets are ever logged.
const NEAR_CONNECT_URL = "https://cdn.jsdelivr.net/npm/@hot-labs/near-connect@0.12.0/+esm";
const NACL_URL = "https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/+esm";
const RPCS = ["https://free.rpc.fastnear.com", "https://near.drpc.org"];
const DEPOSIT = "100000000000000000000000"; // 0.1 NEAR
const LS_KEY = "backstop-wallet-test:throwaway-secret"; // base64 of the 32-byte seed
const $ = (id) => document.getElementById(id);

// ---- log ----
const logEl = $("log");
let logText = "";
function log(msg, data) {
  const line =
    `[${new Date().toISOString()}] ${msg}` +
    (data !== undefined ? "\n" + (typeof data === "string" ? data : JSON.stringify(data, null, 2)) : "");
  logText += line + "\n";
  logEl.textContent = logText;
  logEl.scrollTop = logEl.scrollHeight;
}
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(logText);
    log("log copied");
  } catch {
    const r = document.createRange();
    r.selectNodeContents(logEl);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    log("clipboard blocked: log text selected, press Ctrl+C");
  }
};

// ---- base58 / base64 ----
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = ALPHA[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
}
const toB64 = (u8) => btoa(String.fromCharCode(...u8));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ---- throwaway key ----
let seed = null;
let pubKey = null;
let keyBackend = "";
async function pubFromSeed(sd) {
  // WebCrypto cannot import a raw seed, so wrap it in a PKCS8 envelope.
  const prefix = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  const pk8 = new Uint8Array(48);
  pk8.set(prefix);
  pk8.set(sd, 16);
  try {
    const priv = await crypto.subtle.importKey("pkcs8", pk8, { name: "Ed25519" }, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", priv);
    const x = jwk.x.replace(/-/g, "+").replace(/_/g, "/");
    keyBackend = "webcrypto";
    return fromB64(x + "=".repeat((4 - (x.length % 4)) % 4));
  } catch {
    const nacl = (await import(NACL_URL)).default;
    keyBackend = "tweetnacl";
    return nacl.sign.keyPair.fromSeed(sd).publicKey;
  }
}
async function loadOrCreateKey(force) {
  let stored = null;
  try {
    stored = force ? null : localStorage.getItem(LS_KEY);
  } catch {}
  seed = stored ? fromB64(stored) : crypto.getRandomValues(new Uint8Array(32));
  if (!stored) {
    try {
      localStorage.setItem(LS_KEY, toB64(seed));
    } catch {
      log("WARNING: localStorage unavailable, secret not saved");
    }
  }
  const pub = await pubFromSeed(seed);
  pubKey = "ed25519:" + b58(pub);
  $("pub").textContent = pubKey;
  $("secret").hidden = true;
  log(`throwaway key ${stored ? "loaded" : "generated"} (${keyBackend}); public key ${pubKey}`);
}
$("reveal").onclick = async () => {
  // NEAR secret key format: ed25519:<base58(seed || pub)>. Shown on screen only, never logged.
  const pub = await pubFromSeed(seed);
  const full = new Uint8Array(64);
  full.set(seed);
  full.set(pub, 32);
  const el = $("secret");
  el.textContent = "ed25519:" + b58(full);
  el.hidden = !el.hidden;
};
$("regen").onclick = async () => {
  if (!confirm("Discard the current throwaway key? If you already created a test account with it, you lose control of it unless you saved the secret.")) return;
  await loadOrCreateKey(true);
};

// ---- wallet ----
let connector = null;
let wallet = null;
let accountId = null;
function showAccount() {
  $("acct").textContent = accountId || "not connected";
  $("wname").textContent = (wallet && wallet.manifest && wallet.manifest.name) || "-";
}
function setWallet(w, accounts) {
  wallet = w;
  accountId = (accounts && accounts[0] && accounts[0].accountId) || null;
  showAccount();
  log(w && accountId ? `wallet connected: ${w.manifest && w.manifest.name} / ${accountId}` : "wallet disconnected");
}
(async () => {
  await loadOrCreateKey(false);
  try {
    const { NearConnector } = await import(NEAR_CONNECT_URL);
    connector = new NearConnector({
      network: "mainnet",
      providers: { mainnet: [...RPCS] },
      features: { signAndSendTransaction: true, signInWithoutAddKey: true },
      autoConnect: true,
    });
    connector.on("wallet:signIn", ({ wallet: w, accounts }) => setWallet(w, accounts));
    connector.on("wallet:signOut", () => setWallet(null, null));
    log("near-connect 0.12.0 loaded");
    try {
      await connector.whenManifestLoaded;
      const { wallet: w, accounts } = await connector.getConnectedWallet();
      setWallet(w, accounts);
    } catch {
      log("no remembered wallet");
    }
  } catch (e) {
    log("FAILED to load near-connect: " + ((e && e.message) || e));
  }
})();

// Same classification as apps/web/lib/wallet-errors.ts: an open request is not a rejection.
const PENDING_TEXT =
  /already pending|already processing|already (has|have) a (pending|open) request|previous request (is )?(still )?(active|pending|open|in progress)|request (is )?already (active|open|in progress)|connection declined/i;
function errorKind(e) {
  const links = [];
  for (let cur = e, i = 0; cur && i < 5; i++, cur = typeof cur === "object" ? cur.cause : null) {
    links.push(typeof cur === "string" ? { message: cur } : { message: String(cur.shortMessage || cur.message || ""), code: cur.code });
  }
  if (links.some((l) => l.code === -32002 || PENDING_TEXT.test(l.message))) return "pending";
  if (links.some((l) => l.code === 4001 || /user (rejected|denied|cancel|closed)|rejected the request/i.test(l.message))) return "rejected";
  return "other";
}

// connect() runs synchronously inside the click, no await before it. One connect at a time: a second
// click while the picker or wallet is open does nothing; after 30 s the button offers a reset.
const CONNECT_STALL_MS = 30_000;
let connectToken = 0;
let connectOpen = false;
function setConnectButton(label, disabled) {
  $("connect").textContent = label;
  $("connect").disabled = disabled;
}
$("connect").onclick = () => {
  if (!connector) {
    log("connector not ready yet, try again in a second");
    return;
  }
  if (connectOpen) {
    // After the stall the same button is "Stop waiting": free the slot (the wallet may still show the old request).
    connectOpen = false;
    connectToken++;
    setConnectButton("Try again", false);
    log("stopped waiting for the wallet; finish or reject any request still open in it, then press Try again");
    return;
  }
  const token = ++connectToken;
  connectOpen = true;
  setConnectButton("Waiting for wallet...", true);
  const stall = setTimeout(() => {
    if (token !== connectToken) return;
    setConnectButton("Stop waiting", false);
    log("still waiting for your wallet: open it and approve or reject the request, or press Stop waiting");
  }, CONNECT_STALL_MS);
  const done = () => {
    clearTimeout(stall);
    if (token !== connectToken) return false; // the user already stopped waiting: stale answer
    connectOpen = false;
    return true;
  };
  connector.connect().then(
    () => {
      if (done()) setConnectButton("Connect wallet", false);
    },
    (e) => {
      if (!done()) return;
      const kind = errorKind(e);
      setConnectButton(kind === "rejected" ? "Connect wallet" : "Try again", false);
      if (kind === "pending") log("connect blocked: your wallet still has an earlier request open. Open your wallet, finish or reject it, then press Try again.");
      else if (kind === "rejected") log("connect cancelled in the wallet");
      else log("connect error: " + ((e && e.message) || e) + ". Press Try again.");
    },
  );
};
$("disconnect").onclick = async () => {
  try {
    await connector?.disconnect();
  } catch (e) {
    log("disconnect error: " + ((e && e.message) || e));
  }
};

// ---- RPC ----
async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, params }),
      });
      return await r.json();
    } catch (e) {
      last = e;
      log(`rpc ${url} unreachable: ${(e && e.message) || e}`);
    }
  }
  throw last;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Find SuccessValue (base64) anywhere in the outcome; return decoded text.
function findSuccessValue(o) {
  const stack = [o];
  const out = [];
  while (stack.length) {
    const x = stack.pop();
    if (x && typeof x === "object") {
      if (typeof x.SuccessValue === "string") out.push(x.SuccessValue);
      for (const v of Object.values(x)) stack.push(v);
    }
  }
  return out.map((b) => {
    try {
      return atob(b);
    } catch {
      return b;
    }
  });
}

function setVerdict(cls, text) {
  const v = $("verdict");
  v.className = cls;
  v.textContent = text;
}

// ---- create ----
let creating = false;
$("create").onclick = () => {
  // No await before the wallet call (popup blockers).
  if (!wallet || !accountId) {
    log("connect a wallet first");
    return;
  }
  if (creating) {
    log("a wallet request is already open: approve or reject it in your wallet first");
    return;
  }
  creating = true;
  const rand = crypto.getRandomValues(new Uint8Array(4));
  const hex = [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
  const newId = `bkst-test-${hex}.near`;
  const newKey = pubKey;
  const walletName = wallet.manifest && wallet.manifest.name;
  setVerdict("", "");
  $("finalvalue").textContent = "";
  log(`wallet=${walletName} signer=${accountId} requesting create_account new_account_id=${newId} new_public_key=${newKey} deposit=${DEPOSIT}`);
  wallet
    .signAndSendTransaction({
      network: "mainnet",
      signerId: accountId,
      receiverId: "near",
      actions: [
        {
          type: "FunctionCall",
          params: { methodName: "create_account", args: { new_account_id: newId, new_public_key: newKey }, gas: "50000000000000", deposit: DEPOSIT },
        },
      ],
    })
    .then(
      (outcome) => {
        creating = false;
        return afterWallet(walletName, newId, newKey, outcome);
      },
      (e) => {
        creating = false;
        log(`wallet=${walletName} wallet call FAILED (${errorKind(e)})`, { message: (e && e.message) || String(e), name: e && e.name });
        setVerdict(
          "fail",
          errorKind(e) === "pending"
            ? "NOT SENT: your wallet still has an earlier request open. Finish or reject it there, then press Create again."
            : "FAIL: wallet rejected or errored before broadcast",
        );
      },
    );
};

async function afterWallet(walletName, newId, newKey, outcome) {
  log(`wallet=${walletName} raw outcome`, outcome);
  const sv = findSuccessValue(outcome);
  if (sv.length) {
    $("finalvalue").textContent = "SuccessValue (decoded): " + sv.join(" | ");
    log("SuccessValue (decoded): " + sv.join(" | "));
  } else {
    log("no SuccessValue found in outcome");
  }
  const failure = JSON.stringify(outcome == null ? "" : outcome).includes('"Failure"');
  if (failure) log("outcome contains a Failure entry");
  const falseReturned = sv.some((s) => s.trim() === "false");
  if (falseReturned) log("create_account returned false: name taken or invalid");

  setVerdict("", "Polling RPC for the new access key (up to 60 s)...");
  let lastErr = "";
  for (let i = 0; i < 30; i++) {
    try {
      const r = await rpc("query", { request_type: "view_access_key", finality: "final", account_id: newId, public_key: newKey });
      if (r.result && !r.result.error) {
        log(`poll ${i + 1}: key found`, r.result);
        setVerdict("pass", `PASS: ${newId} exists and ${newKey} is an access key (wallet: ${walletName})`);
        log(`PASS account=${newId}. Refund steps are in README.md`);
        return;
      }
      lastErr = JSON.stringify(r.error || r.result);
      if (i % 5 === 0) log(`poll ${i + 1}: not yet`, lastErr.slice(0, 300));
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
    await sleep(2000);
  }
  let reason = "account/key never appeared within 60 s";
  if (falseReturned) reason = "create_account returned false (name taken or invalid); tx succeeded but no account was made";
  else if (failure) reason = "outcome reports a Failure";
  else if (sv.length) reason = "tx reported success but the account never appeared";
  setVerdict("fail", `FAIL: ${reason}`);
  log(`FAIL account=${newId} wallet=${walletName} reason=${reason}; last RPC answer: ${lastErr.slice(0, 400)}`);
}
